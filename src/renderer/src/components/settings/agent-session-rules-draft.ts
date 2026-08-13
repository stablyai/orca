import type { AgentSessionRule } from '../../../../shared/agent-session-rules-types'

export type AgentSessionRuleTextDraft = { label: string; content: string }

export function readAgentSessionRuleTextDraft(rule: AgentSessionRule): AgentSessionRuleTextDraft {
  return { label: rule.label, content: rule.content }
}

/** Overlay in-flight label/content edits onto the persisted rule list for display. */
export function composeDisplayAgentSessionRules(
  rules: AgentSessionRule[],
  textDraftsById: Partial<Record<string, AgentSessionRuleTextDraft>>
): AgentSessionRule[] {
  return rules.map((rule) => {
    const draft = textDraftsById[rule.id]
    return draft ? { ...rule, label: draft.label, content: draft.content } : rule
  })
}

/** Per-rule dirty flags: does the text draft differ from the persisted rule? */
export function computeAgentSessionRuleDirtyById(
  persistedRules: AgentSessionRule[],
  textDraftsById: Partial<Record<string, AgentSessionRuleTextDraft>>
): Record<string, boolean> {
  const persistedById = new Map(persistedRules.map((rule) => [rule.id, rule]))
  const result: Record<string, boolean> = {}
  for (const [id, draft] of Object.entries(textDraftsById)) {
    const persisted = persistedById.get(id)
    result[id] = Boolean(
      draft && persisted && (draft.label !== persisted.label || draft.content !== persisted.content)
    )
  }
  return result
}

/** Drop a rule's draft after save unless the user typed something newer while save was in flight. */
export function clearAgentSessionRuleTextDraftIfUnchanged(
  current: Partial<Record<string, AgentSessionRuleTextDraft>>,
  ruleId: string,
  saved: AgentSessionRuleTextDraft
): Partial<Record<string, AgentSessionRuleTextDraft>> {
  const latest = current[ruleId]
  if (latest && (latest.label !== saved.label || latest.content !== saved.content)) {
    return current
  }
  const { [ruleId]: _removed, ...rest } = current
  return rest
}

export function patchAgentSessionRuleTextDraft(
  current: Partial<Record<string, AgentSessionRuleTextDraft>>,
  rule: AgentSessionRule,
  patch: Partial<AgentSessionRuleTextDraft>
): Partial<Record<string, AgentSessionRuleTextDraft>> {
  return {
    ...current,
    [rule.id]: {
      ...(current[rule.id] ?? readAgentSessionRuleTextDraft(rule)),
      ...patch
    }
  }
}

/** Timestamp+random id; custom rules don't need crypto.randomUUID's collision guarantees. */
export function mintCustomAgentSessionRuleId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
