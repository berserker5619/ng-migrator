import path from 'node:path';
import { readJsonIfExists } from '../platform/fs.js';
import builtInRulesJson from '../rules/built-in-rules.json' with { type: 'json' };

export interface MigrationRule {
  package: string;
  status?: 'deprecated' | 'abandoned' | 'maintained';
  lastReleaseFor?: number;
  category?: 'layout' | 'ui' | 'utility' | 'auth' | 'crypto' | 'sdk' | string;
  recommendation?: 'upgrade' | 'alternate' | 'fork' | 'inline' | 'manual';
  alternatives?: string[];
  fork?: string;
  notes?: string;
}

export function getBuiltInRules(): MigrationRule[] {
  return builtInRulesJson as MigrationRule[];
}

export async function loadRules(rulePaths: readonly string[], projectRoot: string): Promise<MigrationRule[]> {
  const rules = [...getBuiltInRules()];

  for (const relOrAbs of rulePaths) {
    const fullPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(projectRoot, relOrAbs);
    try {
      const userRules = await readJsonIfExists<MigrationRule[] | { rules?: MigrationRule[] }>(fullPath);
      if (Array.isArray(userRules)) {
        rules.push(...userRules);
      } else if (userRules && Array.isArray(userRules.rules)) {
        rules.push(...userRules.rules);
      }
    } catch {
      // ignore invalid or unreadable extra rule files
    }
  }

  return rules;
}

export function findRule(packageName: string, rules: readonly MigrationRule[]): MigrationRule | undefined {
  // Exact match first, then prefix match
  return rules.find((r) => r.package === packageName);
}

