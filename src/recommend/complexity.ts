import type { VersionMeta } from '../registry/client.js';

export interface ComplexitySignals {
  packageName: string;
  hasHardProblems: boolean;
  hardProblemCategories: string[];
  dependencyCount: number;
  isPresentational: boolean;
  complexityLevel: 'low' | 'medium' | 'high';
}

const HARD_PROBLEM_KEYWORDS: Record<string, string[]> = {
  charts: ['chart', 'graph', 'canvas', 'svg', 'echarts', 'd3'],
  editor: ['rich-text', 'wysiwyg', 'editor', 'markdown', 'codemirror', 'monaco'],
  virtualization: ['virtual-scroll', 'virtual-list', 'infinite-scroll'],
  positioning: ['popper', 'floating-ui', 'overlay', 'tether'],
  dateMath: ['date', 'calendar', 'datepicker', 'timepicker', 'moment', 'dayjs', 'luxon'],
  dragDrop: ['drag', 'drop', 'dnd', 'draggable', 'sortable'],
};

const SIMPLE_PRIMITIVE_KEYWORDS = [
  'tooltip',
  'clipboard',
  'click-outside',
  'debounce',
  'throttle',
  'copy',
  'auto-focus',
  'truncate',
  'scroll-to',
];

export function evaluateComplexity(
  packageName: string,
  latestMeta?: VersionMeta,
  description?: string,
): ComplexitySignals {
  const text = `${packageName} ${description ?? ''}`.toLowerCase();
  const hardCategories: string[] = [];

  for (const [category, keywords] of Object.entries(HARD_PROBLEM_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      hardCategories.push(category);
    }
  }

  const isPresentational = SIMPLE_PRIMITIVE_KEYWORDS.some((kw) => text.includes(kw));
  const depCount = Object.keys(latestMeta?.peerDependencies ?? {}).length;

  let complexityLevel: 'low' | 'medium' | 'high' = 'medium';
  if (isPresentational && hardCategories.length === 0) {
    complexityLevel = 'low';
  } else if (hardCategories.length >= 2 || hardCategories.includes('editor') || hardCategories.includes('charts')) {
    complexityLevel = 'high';
  }

  return {
    packageName,
    hasHardProblems: hardCategories.length > 0,
    hardProblemCategories: hardCategories,
    dependencyCount: depCount,
    isPresentational,
    complexityLevel,
  };
}

