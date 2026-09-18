import type { Conflict, Resolutions } from './threeWayMerge';

/** 批量决策方向：采用当前分支 / 采用目标分支 */
export type BatchSide = 'ours' | 'theirs';

/** 编辑区中的一条批量决策规则 */
export interface BatchRule {
  /** 列表渲染用的稳定 id */
  id: string;
  /** JSON Pointer 模式原文（可含 * 与 ** 通配段） */
  pattern: string;
  side: BatchSide;
}

/**
 * 模式段：
 * - literal：字面路径段（已按 RFC 6901 反转义）
 * - one：`*`，匹配一个完整路径段
 * - many：`**`，匹配零个或多个完整路径段
 */
export type PatternSegment =
  | { type: 'literal'; value: string }
  | { type: 'one' }
  | { type: 'many' };

/** 模式非法时抛出（消息面向用户，可直接在编辑区展示） */
export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

/** 校验并按 RFC 6901 反转义单个路径段（~0 → ~，~1 → /） */
function unescapePatternSegment(seg: string): string {
  // RFC 6901：~ 后只能跟 0 或 1
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '~' && seg[i + 1] !== '0' && seg[i + 1] !== '1') {
      throw new PatternError(`非法转义：段 "${seg}" 中 ~ 后只能跟 0 或 1（RFC 6901）`);
    }
  }
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * 解析 JSON Pointer 模式。
 * 模式必须以 / 开头，按 / 分段；每段遵循 RFC 6901 转义；
 * 段 `*` 匹配一个完整路径段，`**` 匹配零个或多个完整路径段；
 * `*` 与 `**` 必须独占一个路径段（不支持 a*、**x 等段内通配写法）。
 */
export function parsePattern(pattern: string): PatternSegment[] {
  if (!pattern.startsWith('/')) {
    throw new PatternError('模式必须以 / 开头（JSON Pointer 形式，如 /features/**）');
  }
  return pattern
    .slice(1)
    .split('/')
    .map((raw) => {
      if (raw === '*') return { type: 'one' };
      if (raw === '**') return { type: 'many' };
      if (raw.includes('*')) {
        throw new PatternError(`段 "${raw}" 非法：* 与 ** 必须独占一个完整路径段，不支持段内通配`);
      }
      return { type: 'literal', value: unescapePatternSegment(raw) };
    });
}

/** 判断模式是否命中给定路径段序列（`**` 可匹配零段，因此 `/**` 也能命中根节点） */
export function matchSegments(pattern: PatternSegment[], segments: string[]): boolean {
  const [head, ...rest] = pattern;
  if (!head) return segments.length === 0;
  if (head.type === 'many') {
    // 依次尝试让 ** 吸收 0..n 个路径段
    for (let i = 0; i <= segments.length; i++) {
      if (matchSegments(rest, segments.slice(i))) return true;
    }
    return false;
  }
  const [first, ...tail] = segments;
  if (first === undefined) return false;
  if (head.type === 'one') return matchSegments(rest, tail);
  return head.value === first && matchSegments(rest, tail);
}

/** 单条规则的预览结果 */
export interface RulePreview {
  rule: BatchRule;
  /** 模式非法时的错误消息；合法或未填写时为 null */
  error: string | null;
  /** 命中的冲突 id（非法或未填写时为空） */
  matched: string[];
}

/** 同时命中多条规则的冲突 */
export interface MultiMatch {
  conflictId: string;
  pointer: string;
  /** 命中该冲突的规则下标（按规则自上而下） */
  ruleIndexes: number[];
}

export interface BatchPreview {
  rules: RulePreview[];
  multiMatches: MultiMatch[];
  /** 是否存在非法模式（存在时应阻止应用） */
  hasError: boolean;
}

/**
 * 计算批量规则预览：每条规则的命中冲突，以及同时命中多条规则的冲突。
 * 空白模式行视为未填写，不参与预览，也不算错误。
 */
export function previewBatch(rules: BatchRule[], conflicts: Conflict[]): BatchPreview {
  const previews: RulePreview[] = rules.map((rule) => {
    if (rule.pattern.trim() === '') return { rule, error: null, matched: [] };
    let parsed: PatternSegment[];
    try {
      parsed = parsePattern(rule.pattern);
    } catch (err) {
      return { rule, error: err instanceof Error ? err.message : String(err), matched: [] };
    }
    return {
      rule,
      error: null,
      matched: conflicts.filter((c) => matchSegments(parsed, c.segments)).map((c) => c.id),
    };
  });
  // 统计每个冲突被哪些（合法）规则命中，筛出多重命中
  const hits = new Map<string, number[]>();
  previews.forEach((p, i) => {
    for (const id of p.matched) {
      const arr = hits.get(id) ?? [];
      arr.push(i);
      hits.set(id, arr);
    }
  });
  const multiMatches: MultiMatch[] = [];
  for (const c of conflicts) {
    const ruleIndexes = hits.get(c.id);
    if (ruleIndexes && ruleIndexes.length > 1) {
      multiMatches.push({ conflictId: c.id, pointer: c.pointer, ruleIndexes });
    }
  }
  return { rules: previews, multiMatches, hasError: previews.some((p) => p.error !== null) };
}

export interface BatchApplyResult {
  /** 合并批量决策后的完整解决方案表（原有选择原样保留） */
  resolutions: Resolutions;
  /** 本次实际写入解决方案的冲突数 */
  applied: number;
}

/**
 * 应用批量决策规则：
 * - 每条冲突按规则自上而下取首条命中的规则；
 * - 只写入尚未有选择的冲突，绝不覆盖已有的手动或快照恢复选择；
 * - 空白模式行忽略；存在非法模式时抛 PatternError（调用方应先通过预览阻止应用）。
 */
export function applyBatchRules(
  rules: BatchRule[],
  conflicts: Conflict[],
  current: Resolutions,
): BatchApplyResult {
  const active: { pattern: PatternSegment[]; side: BatchSide }[] = [];
  for (const rule of rules) {
    if (rule.pattern.trim() === '') continue;
    active.push({ pattern: parsePattern(rule.pattern), side: rule.side });
  }
  const next: Resolutions = { ...current };
  let applied = 0;
  for (const c of conflicts) {
    if (next[c.id]) continue; // 已有手动 / 快照恢复的选择，绝不覆盖
    for (const a of active) {
      if (matchSegments(a.pattern, c.segments)) {
        next[c.id] = { kind: a.side };
        applied++;
        break; // 首条命中即生效
      }
    }
  }
  return { resolutions: next, applied };
}
