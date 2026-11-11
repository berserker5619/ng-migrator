import type { Blocker } from '../model.js';
import type { RegistryClient } from '../registry/client.js';
import { findAlternateCandidates } from './alternates.js';
import { evaluateComplexity } from './complexity.js';
import { findRule, type MigrationRule } from './rules.js';
import { analyzePackageUsage, type UsageFootprint } from './usage.js';

export interface RecommendOptions {
  projectRoot: string;
  blocker: Blocker;
  targetMajor: number;
  targetCoreVersion: string;
  registry: RegistryClient;
  rules: readonly MigrationRule[];
  allowList?: readonly string[];
  denyList?: readonly string[];
}

export interface RecommendationResult {
  recommendation: 'upgrade' | 'alternate' | 'fork' | 'inline' | 'remove' | 'manual';
  source: 'analysis' | 'rule';
  confidence: 'high' | 'medium' | 'low';
  effort: string;
  runnerUp?: string;
  reasoning: string;
  recommendedFix: string;
  usage?: {
    filesCount: number;
    templateUsages: number;
    importedSymbols: string[];
    summary: string;
  };
}

export async function computeRecommendation(
  options: RecommendOptions,
): Promise<RecommendationResult> {
  const {
    projectRoot,
    blocker,
    targetMajor,
    targetCoreVersion,
    registry,
    rules,
    allowList = [],
    denyList = [],
  } = options;

  const rule = findRule(blocker.package, rules);

  // Analyze package usage footprint
  let usage: UsageFootprint | undefined;
  try {
    usage = await analyzePackageUsage(projectRoot, blocker.package);
  } catch {
    // fallback if file reading fails
  }

  const extraUsageParts: string[] = [];
  if (usage) {
    if (usage.styleImports.length > 0) {
      extraUsageParts.push(`style imports: [${usage.styleImports.join(', ')}]`);
    }
    if (usage.configReferences.length > 0) {
      extraUsageParts.push(`configs: [${usage.configReferences.join(', ')}]`);
    }
    if (usage.peerRequiredBy.length > 0) {
      extraUsageParts.push(`peer dependency of: [${usage.peerRequiredBy.join(', ')}]`);
    }
  }
  const extraUsageSuffix = extraUsageParts.length > 0 ? `, ${extraUsageParts.join(', ')}` : '';

  const usageData = usage
    ? {
        filesCount: usage.files.length,
        templateUsages: usage.templateOccurrences,
        importedSymbols: usage.importedSymbols,
        summary:
          blocker.package === '@angular/flex-layout'
            ? `${usage.files.length} file(s), ${usage.templateOccurrences} template usage(s) of fx* directives, imports: [${usage.importedSymbols.join(', ')}]${extraUsageSuffix}`
            : `${usage.files.length} file(s), ${usage.templateOccurrences} template usage(s), imports: [${usage.importedSymbols.join(', ')}]${extraUsageSuffix}`,
      }
    : undefined;

  // 0. Zero usage across workspace -> recommend removing (or verifying if checks were incomplete)
  const isUnused =
    usage !== undefined &&
    usage.scannedSourceFilesCount > 0 &&
    usage.files.length === 0 &&
    usage.templateOccurrences === 0 &&
    usage.importedSymbols.length === 0 &&
    usage.callSiteCount === 0 &&
    usage.styleImports.length === 0 &&
    usage.configReferences.length === 0 &&
    usage.peerRequiredBy.length === 0;

  if (isUnused && usage) {
    let demotedRunnerUp = 'alternate package';
    if (rule?.alternatives && rule.alternatives.length > 0) {
      const preferred = ['CSS flexbox/grid', 'Tailwind CSS'];
      const orderedNames = [
        ...preferred.filter((p) => rule.alternatives!.includes(p)),
        ...rule.alternatives.filter((a) => !preferred.includes(a)),
      ];
      demotedRunnerUp = orderedNames.join(', ');
    } else if (rule?.recommendation === 'inline') {
      demotedRunnerUp = 'Write replacement in project codebase';
    }

    const verified = usage.allUnusedChecksVerified;
    return {
      recommendation: 'remove',
      recommendedFix: verified ? 'remove the unused dependency' : 'appears unused, verify',
      source: 'analysis',
      confidence: verified ? 'high' : 'medium',
      effort: '5 minutes (remove from package.json)',
      runnerUp: demotedRunnerUp,
      reasoning: verified
        ? `No imports, template usages, style imports, config references, or peer-dependency requirements for ${blocker.package} were found across ${usage.scannedSourceFilesCount} source file(s).${rule?.notes ? ` ${rule.notes}` : ''}`
        : `No direct references to ${blocker.package} were found in ${usage.scannedSourceFilesCount} source file(s), but some workspace/peer checks could not be completed; verify before removing.${rule?.notes ? ` ${rule.notes}` : ''}`,
      usage: usageData,
    };
  }

  // 1. Explicit Rule Recommendation (if defined in built-in or user rules)
  if (rule?.recommendation) {
    if (rule.recommendation === 'inline') {
      return {
        recommendation: 'inline',
        source: 'rule',
        confidence: 'high',
        effort: '2 to 3 hours (about 3-4 files)',
        runnerUp: 'alternate package',
        recommendedFix: 'Write replacement in project codebase',
        reasoning: rule.notes ?? 'Rule matches known replaceable utility with small footprint.',
        usage: usageData,
      };
    }
    if (rule.recommendation === 'alternate') {
      const alts = await findAlternateCandidates(
        blocker.package,
        targetMajor,
        targetCoreVersion,
        registry,
        rule,
        allowList,
        denyList,
      );

      // Order alternatives so plain CSS flexbox/grid comes before Tailwind
      let sortedAlts = [...alts];
      if (blocker.package === '@angular/flex-layout' && rule.alternatives) {
        const preferred = ['CSS flexbox/grid', 'Tailwind CSS'];
        const orderedNames = [
          ...preferred.filter((p) => rule.alternatives!.includes(p)),
          ...rule.alternatives.filter((a) => !preferred.includes(a)),
        ];
        sortedAlts = orderedNames.map((name) => {
          const found = alts.find((a) => a.name === name);
          return found ?? { name, supportsTargetAngular: true, isAllowed: true };
        });
      }

      const bestAlt = sortedAlts.find((a) => a.supportsTargetAngular && a.isAllowed);
      const runnerUpAlt = sortedAlts.filter((a) => a.supportsTargetAngular && a.isAllowed && a !== bestAlt)[0];

      return {
        recommendation: 'alternate',
        source: 'rule',
        confidence: 'high',
        effort: '1 to 2 days',
        runnerUp: runnerUpAlt ? runnerUpAlt.name : 'fork',
        recommendedFix: bestAlt ? bestAlt.name : 'CSS flexbox/grid',
        reasoning: rule.notes ?? 'Rule recommends an alternate package or modern styling replacement.',
        usage: usageData,
      };
    }
  }

  // 2. Fetch Complexity Signals
  let latestMeta;
  let description: string | undefined;
  try {
    const pack = await registry.packument(blocker.package);
    if (pack) {
      description = (pack as unknown as { description?: string }).description;
      const latest = pack.distTags.latest;
      if (latest) latestMeta = pack.versions[latest];
    }
  } catch {
    // ignore
  }

  const complexity = evaluateComplexity(blocker.package, latestMeta, description);

  // 3. Resolution Ladder
  // Ladder 4: Small footprint + simple/presentational logic -> Write it in the codebase
  if (
    (usage?.isSmallFootprint || complexity.isPresentational) &&
    !complexity.hasHardProblems &&
    complexity.complexityLevel === 'low'
  ) {
    const symbolCount = usage?.importedSymbols.length ?? 1;
    const fileCount = usage?.files.length ?? 1;
    return {
      recommendation: 'inline',
      source: 'analysis',
      confidence: 'high',
      effort: '2 to 3 hours',
      runnerUp: 'alternate package (confidence: medium)',
      recommendedFix: 'Write small directive in project codebase',
      reasoning: `Small footprint (${symbolCount} symbol(s) used across ${fileCount} file(s)) and simple logic. CDK or a small in-project directive covers the needed behavior.`,
      usage: usageData,
    };
  }

  // Ladder 2 & 3: Check Alternate Candidates
  const alternates = await findAlternateCandidates(
    blocker.package,
    targetMajor,
    targetCoreVersion,
    registry,
    rule,
    allowList,
    denyList,
  );
  const supportedAlt = alternates.find((a) => a.supportsTargetAngular && a.isAllowed);

  if (supportedAlt) {
    return {
      recommendation: 'alternate',
      source: 'analysis',
      confidence: 'medium',
      effort: '1 to 2 days',
      runnerUp: 'write it in the codebase',
      recommendedFix: supportedAlt.name,
      reasoning: `Alternate package "${supportedAlt.name}" supports Angular ${targetMajor}.`,
      usage: usageData,
    };
  }

  // Fork if specified in rule
  if (rule?.fork) {
    return {
      recommendation: 'fork',
      source: 'rule',
      confidence: 'medium',
      effort: 'half day',
      runnerUp: 'manual',
      recommendedFix: `Use fork ${rule.fork}`,
      reasoning: `Maintained fork available: ${rule.fork}`,
      usage: usageData,
    };
  }

  // If this is a soft blocker (a published version declares compatibility with targetMajor, but is deprecated/unmaintained)
  if (!blocker.hard) {
    return {
      recommendation: 'upgrade',
      source: 'analysis',
      confidence: 'medium',
      effort: '15 to 30 minutes (verify in build and tests)',
      runnerUp: 'replace with maintained alternative or in-project utility',
      recommendedFix: 'Upgrade to declared-compatible release and monitor maintenance risk',
      reasoning: `A release of ${blocker.package} declares peer compatibility with Angular ${targetMajor}, though the package is flagged as ${blocker.reason}. Verify behavior during build and tests.`,
      usage: usageData,
    };
  }

  // Ladder 5: Manual fallback
  return {
    recommendation: 'manual',
    source: 'analysis',
    confidence: 'low',
    effort: 'several days',
    runnerUp: 'fork or inline replacement',
    recommendedFix: 'Manual refactoring',
    reasoning: `No compatible version or known alternate found for ${blocker.package}. Manual audit and replacement required.`,
    usage: usageData,
  };
}
