// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import BatchRulesPanel from './BatchRulesPanel';
import { threeWayMerge, type Resolutions } from '../merge/threeWayMerge';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 三个冲突：/f/a、/f/b、/g
const mergeResult = threeWayMerge(
  { f: { a: 1, b: 1 }, g: 1 },
  { f: { a: 2, b: 2 }, g: 2 },
  { f: { a: 3, b: 3 }, g: 3 },
);
const conflictId = (pointer: string) =>
  mergeResult.conflicts.find((c) => c.pointer === pointer)!.id;

function makeRenderer(container: HTMLElement) {
  const root = createRoot(container);
  return (node: ReactElement) => act(() => root.render(node));
}

const h = (container: HTMLElement, sel: string) => container.querySelector(sel);
const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeInto(input: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** select 同理：原生 setter 赋值后派发 change 事件 */
function selectInto(select: HTMLSelectElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, v);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function setup(initial: Resolutions = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let resolutions = initial;
  let applied: Resolutions | null = null;
  const render = makeRenderer(container);
  const rerender = () =>
    render(
      <BatchRulesPanel
        conflicts={mergeResult.conflicts}
        resolutions={resolutions}
        onApply={(next) => {
          applied = next;
          resolutions = next;
          rerender();
        }}
        onSelectConflict={() => {}}
      />,
    );
  rerender();
  return { container, getApplied: () => applied };
}

describe('BatchRulesPanel', () => {
  it('非法模式就地报错并阻止应用；修正后显示命中数并可应用', () => {
    const { container, getApplied } = setup();

    // 添加规则并输入非法模式（未以 / 开头）
    act(() => btnByText(container, '添加规则')!.click());
    const input = h(container, '.batch-rule-row input') as HTMLInputElement;
    act(() => typeInto(input, 'features/**'));
    expect(h(container, '.batch-rule-error')?.textContent).toContain('必须以 / 开头');
    expect(btnByText(container, '应用规则')?.disabled).toBe(true);
    expect(h(container, '.batch-blocked')?.textContent).toContain('非法模式');

    // 段内通配同样报错
    act(() => typeInto(input, '/f/a*'));
    expect(h(container, '.batch-rule-error')?.textContent).toContain('独占一个完整路径段');
    expect(btnByText(container, '应用规则')?.disabled).toBe(true);

    // 修正为合法模式：显示命中数，应用按钮可用
    act(() => typeInto(input, '/f/*'));
    expect(h(container, '.batch-rule-error')).toBeNull();
    expect(h(container, '.rule-hit')?.textContent).toBe('命中 2');
    const applyBtn = btnByText(container, '应用规则')!;
    expect(applyBtn.disabled).toBe(false);
    expect(applyBtn.textContent).toContain('2 个冲突');

    // 应用：/f/a、/f/b 采用当前分支，/g 未命中保持未解决
    act(() => applyBtn.click());
    const applied = getApplied()!;
    expect(applied[conflictId('/f/a')]).toEqual({ kind: 'ours' });
    expect(applied[conflictId('/f/b')]).toEqual({ kind: 'ours' });
    expect(applied[conflictId('/g')]).toBeUndefined();
    expect(h(container, '.batch-feedback')?.textContent).toContain('2 个');
  });

  it('同时命中多条规则的冲突单独列出，应用时取首条命中规则且不覆盖已有选择', () => {
    // /g 已有手动选择（模拟手动或快照恢复）
    const { container, getApplied } = setup({ [conflictId('/g')]: { kind: 'custom', value: 9 } });

    // 规则 1：/f/a → 目标分支；规则 2：/** → 当前分支
    act(() => btnByText(container, '添加规则')!.click());
    act(() => btnByText(container, '添加规则')!.click());
    const inputs = all(container, '.batch-rule-row input') as HTMLInputElement[];
    act(() => typeInto(inputs[0], '/f/a'));
    act(() => typeInto(inputs[1], '/**'));
    // 规则 1 采用目标分支，规则 2 保持默认的当前分支
    const selects = all(container, '.batch-rule-row select') as HTMLSelectElement[];
    act(() => selectInto(selects[0], 'theirs'));

    // 预览：规则 1 命中 1，规则 2 命中 3；/f/a 同时命中两条规则被单列
    const hits = all(container, '.rule-hit').map((x) => x.textContent);
    expect(hits).toEqual(['命中 1', '命中 3']);
    const multi = all(container, '.batch-multi li');
    expect(multi).toHaveLength(1);
    expect(multi[0].textContent).toContain('/f/a');
    expect(multi[0].textContent).toContain('规则 1、2');

    // 应用按钮只统计尚未选择且命中的冲突：/f/a、/f/b（/g 已有选择）
    const applyBtn = btnByText(container, '应用规则')!;
    expect(applyBtn.textContent).toContain('2 个冲突');
    act(() => applyBtn.click());

    const applied = getApplied()!;
    // 首条命中：/f/a 按规则 1 采用目标分支
    expect(applied[conflictId('/f/a')]).toEqual({ kind: 'theirs' });
    // /f/b 命中规则 2 采用当前分支
    expect(applied[conflictId('/f/b')]).toEqual({ kind: 'ours' });
    // 已有手动选择不被覆盖
    expect(applied[conflictId('/g')]).toEqual({ kind: 'custom', value: 9 });
  });
});
