import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { walkProject } from '../reader/files.js';

export interface UsageFootprint {
  packageName: string;
  files: string[];
  importedSymbols: string[];
  callSiteCount: number;
  templateOccurrences: number;
  isSmallFootprint: boolean;
}

/**
 * Analyzes a project's TypeScript and template files to calculate the usage
 * footprint of a given package (plan section 8.1).
 */
export async function analyzePackageUsage(
  projectRoot: string,
  packageName: string,
): Promise<UsageFootprint> {
  const tsFiles = await walkProject(projectRoot, { extensions: ['.ts'] });
  const htmlFiles = await walkProject(projectRoot, { extensions: ['.html'] });

  const referencingFiles = new Set<string>();
  const importedSymbols = new Set<string>();
  let callSiteCount = 0;
  let templateOccurrences = 0;

  for (const relFile of tsFiles) {
    if (relFile.endsWith('.d.ts')) continue;
    const fullPath = path.join(projectRoot, relFile);
    let code: string;
    try {
      code = await readFile(fullPath, 'utf8');
    } catch {
      continue;
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
        // Skip identifier in the import declaration itself
        if (!ts.isImportClause(node.parent) && !ts.isImportSpecifier(node.parent)) {
          callSiteCount++;
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // Scan templates for selector usages based on imported symbol names or package name hints
  const symbolWords = [...importedSymbols]
    .map((s) => s.replace(/Directive|Component|Pipe|Module/g, '').toLowerCase())
    .filter((w) => w.length > 2);

  for (const relHtml of htmlFiles) {
    const fullPath = path.join(projectRoot, relHtml);
    try {
      const html = await readFile(fullPath, 'utf8');
      for (const word of symbolWords) {
        if (html.toLowerCase().includes(word)) {
          templateOccurrences++;
          referencingFiles.add(relHtml);
        }
      }
    } catch {
      // ignore unreadable
    }
  }

  const files = [...referencingFiles].sort();
  const isSmallFootprint = files.length <= 4 && importedSymbols.size <= 3 && callSiteCount <= 10;

  return {
    packageName,
    files,
    importedSymbols: [...importedSymbols].sort(),
    callSiteCount,
    templateOccurrences,
    isSmallFootprint,
  };
}
