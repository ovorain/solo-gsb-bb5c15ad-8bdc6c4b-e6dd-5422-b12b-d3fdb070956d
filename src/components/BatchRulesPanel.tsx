import { useMemo, useState } from 'react';
import type { Conflict, Resolutions } from '../merge/threeWayMerge';
import {
  applyBatchRules,
  previewBatch,
  PatternError,
  type BatchRule,
  type BatchSide,
} from '../merge/batchRules';

interface Props {
  conflicts: Conflict[];
  resolutions: Resolutions;
  /** 应用批量规则后的新解决方案表 */
  onApply: (next: Resolutions) => void;
  /** 点击预览中的冲突指针时定位到该冲突 */
  onSelectConflict: (id: string) => void;
}

let nextRuleId = 1;
const newRule = (): BatchRule => ({ id: `r${nextRuleId++}`, pattern: '', side: 'ours' });

export default function BatchRulesPanel({ conflicts, resolutions, onApply, onSelectConflict }: Props) {
  const [rules, setRules] = useState<BatchRule[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);

  const preview = useMemo(() => previewBatch(rules, conflicts), [rules, conflicts]);

  // 本次应用将写入的冲突数：尚未选择 + 命中至少一条合法规则
  const applicable = useMemo(() => {
    if (preview.hasError) return 0;
    let n = 0;
    for (const c of conflicts) {
      if (resolutions[c.id]) continue;
      if (preview.rules.some((p) => p.matched.includes(c.id))) n++;
    }
    return n;
  }, [preview, conflicts, resolutions]);

  const mutateRules = (fn: (rs: BatchRule[]) => BatchRule[]) => {
    setFeedback(null);
    setRules(fn);
  };

  const updateRule = (id: string, patch: Partial<BatchRule>) =>
    mutateRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const moveRule = (index: number, delta: number) =>
    mutateRules((rs) => {
      const j = index + delta;
      if (j < 0 || j >= rs.length) return rs;
      const copy = [...rs];
      [copy[index], copy[j]] = [copy[j], copy[index]];
      return copy;
    });

  const removeRule = (id: string) => mutateRules((rs) => rs.filter((r) => r.id !== id));

  const handleApply = () => {
    try {
      const { resolutions: next, applied } = applyBatchRules(rules, conflicts, resolutions);
      onApply(next);
      setFeedback(
        applied > 0
          ? `✅ 已为 ${applied} 个未解决冲突应用规则；已有选择的冲突未受影响，仍可逐项改选。`
          : '没有可应用的冲突：命中的冲突均已有选择，或规则未命中任何冲突。',
      );
    } catch (err) {
      // 防御：正常流程下非法模式已在编辑区就地报错并禁用应用按钮
      setFeedback(err instanceof PatternError ? `应用被阻止：${err.message}` : String(err));
    }
  };

  const canApply = rules.length > 0 && !preview.hasError && applicable > 0;

  return (
    <div className="batch-rules">
      <div className="batch-head">
        <h3>批量决策规则</h3>
        <span className="hint">
          按 JSON Pointer 模式批量选择（* 匹配一段，** 匹配零至多段）；自上而下取首条命中，仅作用于尚未选择的冲突
        </span>
        <button className="small" onClick={() => mutateRules((rs) => [...rs, newRule()])}>
          + 添加规则
        </button>
      </div>
      {rules.length === 0 && (
        <div className="batch-empty">
          暂无规则。点击「添加规则」，例如模式 <code>/features/**</code> 可批量处理该子树下的所有冲突。
        </div>
      )}
      {rules.map((rule, i) => {
        const p = preview.rules[i];
        const blank = rule.pattern.trim() === '';
        return (
          <div className="batch-rule" key={rule.id}>
            <div className="batch-rule-row">
              <span className="rule-no">{i + 1}</span>
              <input
                type="text"
                className={p?.error ? 'invalid' : ''}
                placeholder="/path/** 或 /a/*/b"
                value={rule.pattern}
                onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
                spellCheck={false}
              />
              <select
                value={rule.side}
                onChange={(e) => updateRule(rule.id, { side: e.target.value as BatchSide })}
              >
                <option value="ours">采用当前分支</option>
                <option value="theirs">采用目标分支</option>
              </select>
              <span className={`rule-hit${p?.error || blank ? ' dim' : ''}`}>
                {blank ? '未填写' : p?.error ? '—' : `命中 ${p?.matched.length ?? 0}`}
              </span>
              <button className="small" onClick={() => moveRule(i, -1)} disabled={i === 0} title="上移">
                ↑
              </button>
              <button
                className="small"
                onClick={() => moveRule(i, 1)}
                disabled={i === rules.length - 1}
                title="下移"
              >
                ↓
              </button>
              <button className="small" onClick={() => removeRule(rule.id)} title="删除规则">
                ×
              </button>
            </div>
            {p?.error && <div className="batch-rule-error">⚠ {p.error}</div>}
          </div>
        );
      })}
      {preview.multiMatches.length > 0 && (
        <div className="batch-multi">
          <div className="batch-multi-title">
            ⚠ 以下冲突同时命中多条规则，应用时取首条命中规则：
          </div>
          <ul>
            {preview.multiMatches.map((m) => (
              <li key={m.conflictId}>
                <button className="link-pointer" onClick={() => onSelectConflict(m.conflictId)}>
                  {m.pointer || '（根节点）'}
                </button>
                <span className="multi-rules">
                  命中规则 {m.ruleIndexes.map((i) => i + 1).join('、')}（生效：规则{' '}
                  {m.ruleIndexes[0] + 1}）
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {rules.length > 0 && (
        <div className="batch-actions">
          <button className="primary" onClick={handleApply} disabled={!canApply}>
            应用规则（{applicable} 个冲突）
          </button>
          {preview.hasError && <span className="batch-blocked">存在非法模式，请修正后再应用</span>}
          {!preview.hasError && applicable === 0 && !feedback && (
            <span className="batch-blocked">没有可应用的未解决冲突</span>
          )}
          {feedback && <span className="batch-feedback">{feedback}</span>}
        </div>
      )}
    </div>
  );
}
