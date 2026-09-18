import { describe, expect, it } from 'vitest';
import {
  applyBatchRules,
  matchSegments,
  parsePattern,
  previewBatch,
  PatternError,
  type BatchRule,
} from './batchRules';
import { buildMerged, threeWayMerge, type Resolutions } from './threeWayMerge';
import type { JsonValue } from './types';

let ruleSeq = 0;
const rule = (pattern: string, side: BatchRule['side'] = 'ours'): BatchRule => ({
  id: `r${ruleSeq++}`,
  pattern,
  side,
});

/** 制造一批冲突并返回合并结果 */
function conflictsOf(base: JsonValue, ours: JsonValue, theirs: JsonValue) {
  return threeWayMerge(base, ours, theirs).conflicts;
}

describe('parsePattern', () => {
  it('解析字面段并按 RFC 6901 反转义', () => {
    expect(parsePattern('/a/b')).toEqual([
      { type: 'literal', value: 'a' },
      { type: 'literal', value: 'b' },
    ]);
    expect(parsePattern('/a~0b/c~1d')).toEqual([
      { type: 'literal', value: 'a~b' },
      { type: 'literal', value: 'c/d' },
    ]);
  });

  it('解析 * 与 ** 通配段', () => {
    expect(parsePattern('/a/*')).toEqual([
      { type: 'literal', value: 'a' },
      { type: 'one' },
    ]);
    expect(parsePattern('/**')).toEqual([{ type: 'many' }]);
    expect(parsePattern('/a/**/b')).toEqual([
      { type: 'literal', value: 'a' },
      { type: 'many' },
      { type: 'literal', value: 'b' },
    ]);
  });

  it('空段是合法的字面段', () => {
    expect(parsePattern('/')).toEqual([{ type: 'literal', value: '' }]);
  });

  it('拒绝不以 / 开头的模式', () => {
    expect(() => parsePattern('')).toThrow(PatternError);
    expect(() => parsePattern('a/b')).toThrow(PatternError);
    expect(() => parsePattern('**/a')).toThrow(PatternError);
  });

  it('拒绝非法的 RFC 6901 转义', () => {
    expect(() => parsePattern('/a~2b')).toThrow(PatternError);
    expect(() => parsePattern('/a~')).toThrow(PatternError);
    expect(() => parsePattern('/~')).toThrow(PatternError);
  });

  it('拒绝段内通配（* 与 ** 必须独占一个路径段）', () => {
    expect(() => parsePattern('/a*')).toThrow(PatternError);
    expect(() => parsePattern('/*a')).toThrow(PatternError);
    expect(() => parsePattern('/***')).toThrow(PatternError);
    expect(() => parsePattern('/a**b')).toThrow(PatternError);
  });
});

describe('matchSegments', () => {
  const m = (pattern: string, segments: string[]) => matchSegments(parsePattern(pattern), segments);

  it('字面模式精确匹配', () => {
    expect(m('/a/b', ['a', 'b'])).toBe(true);
    expect(m('/a/b', ['a'])).toBe(false);
    expect(m('/a/b', ['a', 'b', 'c'])).toBe(false);
    expect(m('/a/b', ['a', 'x'])).toBe(false);
  });

  it('* 恰好匹配一个完整路径段', () => {
    expect(m('/a/*', ['a', 'b'])).toBe(true);
    expect(m('/a/*', ['a'])).toBe(false);
    expect(m('/a/*', ['a', 'b', 'c'])).toBe(false);
    expect(m('/a/*', ['x', 'b'])).toBe(false);
  });

  it('** 匹配零个或多个完整路径段', () => {
    expect(m('/a/**', ['a'])).toBe(true);
    expect(m('/a/**', ['a', 'b'])).toBe(true);
    expect(m('/a/**', ['a', 'b', 'c'])).toBe(true);
    expect(m('/a/**', ['x'])).toBe(false);
    expect(m('/**', [])).toBe(true);
    expect(m('/**', ['a', 'b'])).toBe(true);
  });

  it('** 可出现在模式中间，且可出现多次', () => {
    expect(m('/a/**/b', ['a', 'b'])).toBe(true);
    expect(m('/a/**/b', ['a', 'x', 'y', 'b'])).toBe(true);
    expect(m('/a/**/b', ['a', 'x', 'y'])).toBe(false);
    expect(m('/**/c/**', ['c'])).toBe(true);
    expect(m('/**/c/**', ['a', 'c', 'd', 'e'])).toBe(true);
    expect(m('/**/c/**', ['a', 'b'])).toBe(false);
  });

  it('字面段按反转义后的值比较', () => {
    expect(m('/a~1b', ['a/b'])).toBe(true);
    expect(m('/a~0b', ['a~b'])).toBe(true);
    expect(m('/a~1b', ['a~1b'])).toBe(false);
  });
});

describe('previewBatch', () => {
  const conflicts = conflictsOf(
    { f: { a: 1, b: 1 }, g: 1 },
    { f: { a: 2, b: 2 }, g: 2 },
    { f: { a: 3, b: 3 }, g: 3 },
  );
  // 三个冲突：/f/a、/f/b、/g

  it('按规则统计命中数量', () => {
    const preview = previewBatch([rule('/f/*'), rule('/g')], conflicts);
    expect(preview.hasError).toBe(false);
    expect(preview.rules[0].matched).toHaveLength(2);
    expect(preview.rules[1].matched).toHaveLength(1);
    expect(preview.multiMatches).toHaveLength(0);
  });

  it('单列同时命中多条规则的冲突', () => {
    const preview = previewBatch([rule('/**'), rule('/f/**'), rule('/f/a')], conflicts);
    // /f/a 命中规则 1/2/3，/f/b 命中规则 1/2
    expect(preview.multiMatches).toHaveLength(2);
    const fa = preview.multiMatches.find((x) => x.pointer === '/f/a');
    expect(fa?.ruleIndexes).toEqual([0, 1, 2]);
    // /g 只命中规则 1，不属于多重命中
    expect(preview.multiMatches.find((x) => x.pointer === '/g')).toBeUndefined();
  });

  it('非法模式就地报错且不参与命中统计', () => {
    const preview = previewBatch([rule('/f/*'), rule('a*')], conflicts);
    expect(preview.hasError).toBe(true);
    expect(preview.rules[1].error).toBeTruthy();
    expect(preview.rules[1].matched).toHaveLength(0);
    expect(preview.multiMatches).toHaveLength(0);
  });

  it('空白模式行视为未填写，不算错误', () => {
    const preview = previewBatch([rule(''), rule('   '), rule('/g')], conflicts);
    expect(preview.hasError).toBe(false);
    expect(preview.rules[0].matched).toHaveLength(0);
    expect(preview.rules[2].matched).toHaveLength(1);
  });
});

describe('applyBatchRules', () => {
  const conflicts = conflictsOf(
    { f: { a: 1, b: 1 }, g: 1 },
    { f: { a: 2, b: 2 }, g: 2 },
    { f: { a: 3, b: 3 }, g: 3 },
  );
  const byPointer = (p: string) => conflicts.find((c) => c.pointer === p)!;

  it('按规则自上而下取首条命中', () => {
    const { resolutions, applied } = applyBatchRules(
      [rule('/f/a', 'theirs'), rule('/**', 'ours')],
      conflicts,
      {},
    );
    expect(applied).toBe(3);
    expect(resolutions[byPointer('/f/a').id]).toEqual({ kind: 'theirs' });
    expect(resolutions[byPointer('/f/b').id]).toEqual({ kind: 'ours' });
    expect(resolutions[byPointer('/g').id]).toEqual({ kind: 'ours' });
  });

  it('绝不覆盖已有手动或快照恢复的选择', () => {
    const existing: Resolutions = {
      [byPointer('/f/a').id]: { kind: 'custom', value: 42 },
      [byPointer('/g').id]: { kind: 'theirs' },
    };
    const { resolutions, applied } = applyBatchRules([rule('/**', 'ours')], conflicts, existing);
    expect(applied).toBe(1);
    expect(resolutions[byPointer('/f/a').id]).toEqual({ kind: 'custom', value: 42 });
    expect(resolutions[byPointer('/g').id]).toEqual({ kind: 'theirs' });
    expect(resolutions[byPointer('/f/b').id]).toEqual({ kind: 'ours' });
    // 不修改传入的 resolutions 对象
    expect(Object.keys(existing)).toHaveLength(2);
  });

  it('未命中任何规则时不产生选择', () => {
    const { resolutions, applied } = applyBatchRules([rule('/nope/**')], conflicts, {});
    expect(applied).toBe(0);
    expect(resolutions).toEqual({});
  });

  it('存在非法模式时抛错，本次应用被阻止', () => {
    expect(() => applyBatchRules([rule('/**'), rule('oops')], conflicts, {})).toThrow(
      PatternError,
    );
  });

  it('应用结果可直接用于 buildMerged 生成合并结果', () => {
    const r = threeWayMerge(
      { f: { a: 1, b: 1 }, g: 1 },
      { f: { a: 2, b: 2 }, g: 2 },
      { f: { a: 3, b: 3 }, g: 3 },
    );
    const { resolutions } = applyBatchRules(
      [rule('/f/**', 'theirs'), rule('/**', 'ours')],
      r.conflicts,
      {},
    );
    expect(buildMerged(r.root, resolutions)).toEqual({ f: { a: 3, b: 3 }, g: 2 });
  });
});
