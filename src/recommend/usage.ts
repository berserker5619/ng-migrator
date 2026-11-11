import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { pathExists, readJsonIfExists } from '../platform/fs.js';
import { walkProject } from '../reader/files.js';

export interface UsageFootprint {
  packageName: string;
  files: string[];
  importedSymbols: string[];
  callSiteCount: number;
  templateOccurrences: number;
  styleImports: string[];
  configReferences: string[];
  peerRequiredBy: string[];
  isSmallFootprint: boolean;
  scannedSourceFilesCount: number;
  allUnusedChecksVerified: boolean;
}

const FX_DIRECTIVE_REGEX = /\b(fx[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)?|fx-[a-z-]+)\b/g;

export function countFlexLayoutTemplateDirectives(templateText: string): number {
  const matches = templateText.match(FX_DIRECTIVE_REGEX);
  return matches ? matches.length : 0;
}

function stringReferencesPackage(value: string, packageName: string): boolean {
  if (value === packageName) return true;
  if (value.startsWith(`${packageName}/`) || value.startsWith(`~${packageName}/`) || value === `~${packageName}`) {
    return true;
  }
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryRegex = new RegExp(`(?:^|[\\s'"/\\\\~])${escaped}(?:$|[\\s'"/\\\\])`);
  return boundaryRegex.test(value);
}

function objectReferencesPackage(obj: unknown, packageName: string): boolean {
  if (typeof obj === 'string') {
    return stringReferencesPackage(obj, packageName);
  }
  if (Array.isArray(obj)) {
    return obj.some((item) => objectReferencesPackage(item, packageName));
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (stringReferencesPackage(k, packageName) || objectReferencesPackage(v, packageName)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Analyzes a project's workspace files, stylesheets, configs, and installed
 * peer dependencies to calculate the usage footprint of a given package
 * and guard against false-positive unused-dependency recommendations.
 */
export async function analyzePackageUsage(
  projectRoot: string,
  packageName: string,
): Promise<UsageFootprint> {
  const tsFiles = (await walkProject(projectRoot, { extensions: ['.ts'] })).filter(
    (f) => !f.endsWith('.d.ts'),
  );
  const htmlFiles = await walkProject(projectRoot, { extensions: ['.html'] });
  const styleFiles = await walkProject(projectRoot, {
    extensions: ['.scss', '.sass', '.css', '.less'],
  });
  const allCandidateConfigFiles = await walkProject(projectRoot, {
    extensions: ['.json', '.js', '.cjs', '.mjs', '.ts'],
  });

  const referencingFiles = new Set<string>();
  const importedSymbols = new Set<string>();
  const styleImports = new Set<string>();
  const configReferences = new Set<string>();
  const peerRequiredBy = new Set<string>();
  let callSiteCount = 0;
  let templateOccurrences = 0;
  let allUnusedChecksVerified = true;

  // 1. Scan TypeScript files (including projects/*, libs/*)
  for (const relFile of tsFiles) {
    const fullPath = path.join(projectRoot, relFile);
    let code: string;
    try {
      code = await readFile(fullPath, 'utf8');
    } catch {
      allUnusedChecksVerified = false;
      continue;
    }

    // Scan inline templates in TypeScript components (before checking code.includes(packageName),
    // because NgModule apps often import FlexLayoutModule in AppModule while using fx* in component inline templates)
    if (packageName === '@angular/flex-layout' && code.includes('template')) {
      const inlineTplRegex = /template\s*:\s*(['"`])([\s\S]*?)\1/g;
      let inlineMatch: RegExpExecArray | null;
      while ((inlineMatch = inlineTplRegex.exec(code)) !== null) {
        const inlineTpl = inlineMatch[2] ?? '';
        const count = countFlexLayoutTemplateDirectives(inlineTpl);
        if (count > 0) {
          templateOccurrences += count;
          referencingFiles.add(relFile);
        }
      }
    }

    if (!code.includes(packageName)) continue;

    const sourceFile = ts.createSourceFile(
      relFile,
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const localNames = new Set<string>();

    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          if (spec === packageName || spec.startsWith(`${packageName}/`)) {
            referencingFiles.add(relFile);
            const clause = node.importClause;
            if (clause) {
              if (clause.name) {
                importedSymbols.add(clause.name.text);
                localNames.add(clause.name.text);
              }
              if (clause.namedBindings) {
                if (ts.isNamedImports(clause.namedBindings)) {
                  for (const elem of clause.namedBindings.elements) {
                    importedSymbols.add(elem.name.text);
                    localNames.add(elem.name.text);
                  }
                } else if (ts.isNamespaceImport(clause.namedBindings)) {
                  importedSymbols.add(`* as ${clause.namedBindings.name.text}`);
                  localNames.add(clause.namedBindings.name.text);
                }
              }
            }
          }
        }
      }

      if (ts.isIdentifier(node) && localNames.has(node.text)) {
        if (!ts.isImportClause(node.parent) && !ts.isImportSpecifier(node.parent)) {
          callSiteCount++;
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // 2. Scan HTML templates across workspace
  const symbolWords = [...importedSymbols]
    .map((s) => s.replace(/Directive|Component|Pipe|Module/g, '').toLowerCase())
    .filter((w) => w.length > 2);

  for (const relHtml of htmlFiles) {
    const fullPath = path.join(projectRoot, relHtml);
    try {
      const html = await readFile(fullPath, 'utf8');

      if (packageName === '@angular/flex-layout') {
        const count = countFlexLayoutTemplateDirectives(html);
        if (count > 0) {
          templateOccurrences += count;
          referencingFiles.add(relHtml);
        }
      } else {
        for (const word of symbolWords) {
          if (html.toLowerCase().includes(word)) {
            templateOccurrences++;
            referencingFiles.add(relHtml);
          }
        }
      }
    } catch {
      allUnusedChecksVerified = false;
    }
  }

  // 3. Scan SCSS / SASS / CSS / LESS files for @use / @import / @forward
  for (const relStyle of styleFiles) {
    const fullPath = path.join(projectRoot, relStyle);
    try {
      const styleContent = await readFile(fullPath, 'utf8');
      if (!styleContent.includes(packageName)) continue;
      const importRegex = /@(?:use|import|forward)\s+(?:url\(\s*)?['"]?(?:~|node_modules\/)?([^'"\s);]+)['"]?/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(styleContent)) !== null) {
        const spec = match[1]!;
        if (spec === packageName || spec.startsWith(`${packageName}/`)) {
          styleImports.add(relStyle);
          referencingFiles.add(relStyle);
        }
      }
    } catch {
      allUnusedChecksVerified = false;
    }
  }

  // 4. Check angular.json (styles, scripts, assets, builder options)
  const angularJsonPath = path.join(projectRoot, 'angular.json');
  if (await pathExists(angularJsonPath)) {
    try {
      const raw = await readFile(angularJsonPath, 'utf8');
      const parsed = ts.parseConfigFileTextToJson('angular.json', raw);
      if (parsed.error || !parsed.config) {
        allUnusedChecksVerified = false;
      } else if (objectReferencesPackage(parsed.config, packageName)) {
        configReferences.add('angular.json');
        referencingFiles.add('angular.json');
      }
    } catch {
      allUnusedChecksVerified = false;
    }
  }

  // 5. Check tsconfig*.json (paths, types), package.json (scripts), and tool config files (karma, jest, eslint, tailwind, postcss)
  for (const relCfg of allCandidateConfigFiles) {
    const base = path.posix.basename(relCfg);
    const fullPath = path.join(projectRoot, relCfg);

    if (/^tsconfig(\..+)?\.json$/i.test(base)) {
      try {
        const raw = await readFile(fullPath, 'utf8');
        const parsed = ts.parseConfigFileTextToJson(relCfg, raw);
        if (parsed.error || !parsed.config) {
          allUnusedChecksVerified = false;
        } else {
          const compilerOptions = (parsed.config as Record<string, unknown>).compilerOptions as
            | Record<string, unknown>
            | undefined;
          if (
            compilerOptions &&
            (objectReferencesPackage(compilerOptions.paths, packageName) ||
              objectReferencesPackage(compilerOptions.types, packageName) ||
              objectReferencesPackage(compilerOptions.plugins, packageName))
          ) {
            configReferences.add(relCfg);
            referencingFiles.add(relCfg);
          }
        }
      } catch {
        allUnusedChecksVerified = false;
      }
      continue;
    }

    if (base === 'package.json') {
      try {
        const pkgJson = await readJsonIfExists<Record<string, unknown>>(fullPath);
        if (!pkgJson) {
          allUnusedChecksVerified = false;
        } else if (pkgJson.scripts && objectReferencesPackage(pkgJson.scripts, packageName)) {
          configReferences.add(relCfg);
          referencingFiles.add(relCfg);
        }
      } catch {
        allUnusedChecksVerified = false;
      }
      continue;
    }

    if (
      /^(karma\.conf|jest\.config|eslint\.config|\.eslintrc|tslint\.json|protractor\.conf|tailwind\.config|postcss\.config|\.postcssrc)/i.test(
        base,
      )
    ) {
      try {
        const content = await readFile(fullPath, 'utf8');
        if (stringReferencesPackage(content, packageName)) {
          configReferences.add(relCfg);
          referencingFiles.add(relCfg);
        }
      } catch {
        allUnusedChecksVerified = false;
      }
    }
  }

  // 6. Check if packageName is a peer dependency of another installed package
  const rootPkg = await readJsonIfExists<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(path.join(projectRoot, 'package.json')).catch(() => undefined);

  const otherDeps = new Set<string>([
    ...Object.keys(rootPkg?.dependencies ?? {}),
    ...Object.keys(rootPkg?.devDependencies ?? {}),
  ]);
  otherDeps.delete(packageName);

  const hasNodeModules = await pathExists(path.join(projectRoot, 'node_modules'));
  const pkgLock = await readJsonIfExists<{
    packages?: Record<string, { peerDependencies?: Record<string, string> }>;
    dependencies?: Record<string, { peerDependencies?: Record<string, string>; requires?: Record<string, string> }>;
  }>(path.join(projectRoot, 'package-lock.json')).catch(() => undefined);

  if (pkgLock?.packages) {
    for (const [pkgKey, meta] of Object.entries(pkgLock.packages)) {
      if (!pkgKey.startsWith('node_modules/')) continue;
      const installedName = pkgKey.slice('node_modules/'.length);
      if (installedName === packageName) continue;
      if (meta?.peerDependencies && meta.peerDependencies[packageName] !== undefined) {
        peerRequiredBy.add(installedName);
        referencingFiles.add('package-lock.json');
      }
    }
  }

  if (hasNodeModules) {
    for (const other of otherDeps) {
      const otherPkgJson = await readJsonIfExists<{ peerDependencies?: Record<string, string> }>(
        path.join(projectRoot, 'node_modules', other, 'package.json'),
      ).catch(() => undefined);
      if (otherPkgJson?.peerDependencies?.[packageName] !== undefined) {
        peerRequiredBy.add(other);
        referencingFiles.add(`node_modules/${other}/package.json`);
      }
    }
  }

  // Verify whether peer dependencies of other installed third-party packages could be checked
  const checkedPeerPackages = new Set<string>();
  if (pkgLock?.packages) {
    for (const pkgKey of Object.keys(pkgLock.packages)) {
      if (pkgKey.startsWith('node_modules/')) {
        checkedPeerPackages.add(pkgKey.slice('node_modules/'.length));
      }
    }
  }
  if (hasNodeModules) {
    for (const other of otherDeps) {
      if (await pathExists(path.join(projectRoot, 'node_modules', other, 'package.json'))) {
        checkedPeerPackages.add(other);
      }
    }
  }

  // Also check cached registry packuments in .ng-migrator/cache/registry if present
  const regCacheDir = path.join(projectRoot, '.ng-migrator', 'cache', 'registry');
  if (await pathExists(regCacheDir)) {
    for (const other of otherDeps) {
      if (checkedPeerPackages.has(other)) continue;
      const cacheEntry = await readJsonIfExists<{
        packument?: {
          distTags?: Record<string, string>;
          versions?: Record<string, { peerDependencies?: Record<string, string> }>;
        };
      }>(path.join(regCacheDir, `${encodeURIComponent(other)}.json`)).catch(() => undefined);
      if (cacheEntry?.packument?.versions) {
        checkedPeerPackages.add(other);
        const versions = cacheEntry.packument.versions;
        const latestVer = cacheEntry.packument.distTags?.latest ?? Object.keys(versions).pop();
        const verMeta = latestVer ? versions[latestVer] : undefined;
        if (verMeta?.peerDependencies?.[packageName] !== undefined) {
          peerRequiredBy.add(other);
          referencingFiles.add('package.json');
        }
      }
    }
  }

  const nonAngularOtherDeps = [...otherDeps].filter(
    (d) =>
      !d.startsWith('@angular/') &&
      !d.startsWith('@angular-devkit/') &&
      !d.startsWith('@types/') &&
      !d.startsWith('karma-') &&
      !d.startsWith('jasmine-') &&
      !['rxjs', 'tslib', 'typescript', 'zone.js', 'karma', 'jasmine-core'].includes(d),
  );
  const uncheckedThirdParty = nonAngularOtherDeps.filter((d) => !checkedPeerPackages.has(d));
  if (uncheckedThirdParty.length > 0) {
    // Cannot verify whether other third-party packages require this package as a peer dependency
    allUnusedChecksVerified = false;
  }

  const files = [...referencingFiles].sort();
  const isSmallFootprint =
    files.length <= 4 &&
    importedSymbols.size <= 3 &&
    callSiteCount <= 10 &&
    styleImports.size === 0 &&
    configReferences.size === 0 &&
    peerRequiredBy.size === 0;

  return {
    packageName,
    files,
    importedSymbols: [...importedSymbols].sort(),
    callSiteCount,
    templateOccurrences,
    styleImports: [...styleImports].sort(),
    configReferences: [...configReferences].sort(),
    peerRequiredBy: [...peerRequiredBy].sort(),
    isSmallFootprint,
    scannedSourceFilesCount: tsFiles.length + htmlFiles.length,
    allUnusedChecksVerified,
  };
}
