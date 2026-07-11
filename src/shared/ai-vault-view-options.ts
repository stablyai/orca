import { AI_VAULT_AGENTS, type AiVaultAgent, type AiVaultGroup, type AiVaultSort } from './ai-vault-types'

// The Agent Session History view options that persist across worktree switches
// and panel reopens (issue #8146). Scope and the search query stay per-session.
export type AiVaultViewOptions = {
  // Agents the user turned OFF, persisted as a disable-list (not an enable-list)
  // so agents added to AI_VAULT_AGENTS in a later release stay visible by default
  // instead of silently vanishing from an existing user's frozen enabled-list.
  disabledAgents: AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
}

// Single source of truth for the view-option defaults (see the renderer's
// ai-vault-view-defaults.ts, which derives its constants from this).
export const DEFAULT_AI_VAULT_VIEW_OPTIONS: AiVaultViewOptions = {
  disabledAgents: [],
  sort: 'updated',
  group: 'project',
  hideEmptySessions: false
}

export function cloneDefaultAiVaultViewOptions(): AiVaultViewOptions {
  return { ...DEFAULT_AI_VAULT_VIEW_OPTIONS, disabledAgents: [] }
}

// Enabled agents = the current catalog minus the persisted disabled set, in
// catalog order. New agents are enabled by default; agents dropped from the
// catalog fall away.
export function enabledAiVaultAgents(disabledAgents: readonly AiVaultAgent[]): AiVaultAgent[] {
  const disabled = new Set<string>(disabledAgents)
  return AI_VAULT_AGENTS.filter((agent) => !disabled.has(agent))
}

// Shape-guard for at-rest / hand-edited persisted state (the write path is
// Zod-validated, but a corrupt state file must not crash or blank the panel).
export function normalizeAiVaultViewOptions(value: unknown): AiVaultViewOptions {
  const record = value && typeof value === 'object' ? (value as Partial<AiVaultViewOptions>) : {}
  const catalog = new Set<string>(AI_VAULT_AGENTS)
  const disabledAgents = Array.isArray(record.disabledAgents)
    ? record.disabledAgents.filter(
        (agent): agent is AiVaultAgent => typeof agent === 'string' && catalog.has(agent)
      )
    : []
  return {
    disabledAgents,
    sort: record.sort === 'created' ? 'created' : 'updated',
    group: record.group === 'folder' || record.group === 'agent' ? record.group : 'project',
    hideEmptySessions: record.hideEmptySessions === true
  }
}
