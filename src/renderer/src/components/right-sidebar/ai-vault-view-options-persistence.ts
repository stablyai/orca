import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import {
  DEFAULT_AI_VAULT_GROUP,
  DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS,
  DEFAULT_AI_VAULT_SORT
} from './ai-vault-view-defaults'

export const AI_VAULT_VIEW_OPTIONS_STORAGE_KEY = 'orca.aiVault.viewOptions.v1'

export type AiVaultViewOptions = {
  disabledAgents: AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
}

type AiVaultViewOptionsStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function createDefaultAiVaultViewOptions(): AiVaultViewOptions {
  return {
    disabledAgents: [],
    sort: DEFAULT_AI_VAULT_SORT,
    group: DEFAULT_AI_VAULT_GROUP,
    hideEmptySessions: DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS
  }
}

export function enabledAiVaultAgents(disabledAgents: readonly AiVaultAgent[]): AiVaultAgent[] {
  const disabled = new Set<AiVaultAgent>(disabledAgents)
  return AI_VAULT_AGENTS.filter((agent) => !disabled.has(agent))
}

function isAiVaultSort(value: unknown): value is AiVaultSort {
  return value === 'updated' || value === 'created'
}

function isAiVaultGroup(value: unknown): value is AiVaultGroup {
  return value === 'project' || value === 'folder' || value === 'agent'
}

export function normalizeAiVaultViewOptions(value: unknown): AiVaultViewOptions {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const catalog = new Set<string>(AI_VAULT_AGENTS)
  const normalizedDisabledAgents = Array.isArray(record.disabledAgents)
    ? [...new Set(record.disabledAgents)].filter(
        (agent): agent is AiVaultAgent => typeof agent === 'string' && catalog.has(agent)
      )
    : []
  // Why: a stale catalog or hand-edited value must not leave the panel with no selectable agents.
  const disabledAgents =
    normalizedDisabledAgents.length < AI_VAULT_AGENTS.length ? normalizedDisabledAgents : []

  return {
    disabledAgents,
    sort: isAiVaultSort(record.sort) ? record.sort : DEFAULT_AI_VAULT_SORT,
    group: isAiVaultGroup(record.group) ? record.group : DEFAULT_AI_VAULT_GROUP,
    hideEmptySessions:
      typeof record.hideEmptySessions === 'boolean'
        ? record.hideEmptySessions
        : DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS
  }
}

function getRendererStorage(): AiVaultViewOptionsStorage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readAiVaultViewOptions(
  storage: AiVaultViewOptionsStorage | null = getRendererStorage()
): AiVaultViewOptions {
  if (!storage) {
    return createDefaultAiVaultViewOptions()
  }
  try {
    const raw = storage.getItem(AI_VAULT_VIEW_OPTIONS_STORAGE_KEY)
    return raw ? normalizeAiVaultViewOptions(JSON.parse(raw)) : createDefaultAiVaultViewOptions()
  } catch {
    return createDefaultAiVaultViewOptions()
  }
}

export function writeAiVaultViewOptions(
  options: AiVaultViewOptions,
  storage: AiVaultViewOptionsStorage | null = getRendererStorage()
): boolean {
  if (!storage) {
    return false
  }
  try {
    // Why: view preferences are per client, so desktop and mobile must not overwrite each other.
    storage.setItem(
      AI_VAULT_VIEW_OPTIONS_STORAGE_KEY,
      JSON.stringify(normalizeAiVaultViewOptions(options))
    )
    return true
  } catch {
    return false
  }
}
