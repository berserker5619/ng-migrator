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
  recommendation: 'upgrade' | 'alternate' | 'fork' | 'inline' | 'manual';
  confidence: 'high' | 'medium' | 'low';
  effort: string;
  runnerUp?: string;
  reasoning: string;
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

  // 1. Explicit Rule Recommendation (if defined in built-in or user rules)
  if (rule?.recommendation) {
    if (rule.recommendation === 'inline') {
      return {
        recommendation: 'inline',
        confidence: 'high',
        effort: '2 to 3 hours (about 3-4 files)',
        runnerUp: 'alternate package',
        reasoning: rule.notes ?? 'Rule matches known replaceable utility with small footprint.',
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
      const bestAlt = alts.find((a) => a.supportsTargetAngular && a.isAllowed);
      return {
        recommendation: 'alternate',
        confidence: 'high',
        effort: '1 to 2 days',
        runnerUp: 'fork',
        reasoning: bestAlt
          ? `Recommended replacement: ${bestAlt.name}. ${rule.notes ?? ''}`
          : (rule.notes ?? 'Rule recommends an alternate package or modern styling replacement.'),
      };
    }
  }

  // 2. Fetch Usage Footprint & Complexity Signals
  let usage: UsageFootprint | undefined;
  try {
    usage = await analyzePackageUsage(projectRoot, blocker.package);
  } catch {
    // fallback if file reading fails
  }

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
      confidence: 'high',
      effort: '2 to 3 hours',
      runnerUp: 'alternate package (confidence: medium)',
      reasoning: `Small footprint (${symbolCount} symbol(s) used across ${fileCount} file(s)) and simple logic. CDK or a small in-project directive covers the needed behavior.`,
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
      confidence: 'medium',
      effort: '1 to 2 days',
      runnerUp: 'write it in the codebase',
      reasoning: `Alternate package "${supportedAlt.name}" supports Angular ${targetMajor}.`,
    };
  }

  // Fork if specified in rule
  if (rule?.fork) {
    return {
      recommendation: 'fork',
      confidence: 'medium',
      effort: 'half day',
      runnerUp: 'manual',
      reasoning: `Maintained fork available: ${rule.fork}`,
    };
  }

  // Ladder 5: Manual fallback
  return {
    recommendation: 'manual',
    confidence: 'low',
    effort: 'several days',
    reasoning: `No compatible version or known alternate found for ${blocker.package}. Manual audit and replacement required.`,
  };
}

