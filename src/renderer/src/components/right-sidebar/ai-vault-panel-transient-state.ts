import { useSyncExternalStore } from 'react'
import type { AiVaultScope } from '../../../../shared/ai-vault-types'
import { DEFAULT_AI_VAULT_SCOPE, normalizeAiVaultScopeForContext } from './ai-vault-scope-state'

export const MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES = 512

type AiVaultPanelTransientState = {
  preferredScope: AiVaultScope
  collapsedGroups: ReadonlySet<string>
  expandedSessionIds: ReadonlySet<string>
}

const EMPTY_DISCLOSURE_KEYS: ReadonlySet<string> = new Set()

function createDefaultTransientState(): AiVaultPanelTransientState {
  return {
    preferredScope: DEFAULT_AI_VAULT_SCOPE,
    collapsedGroups: EMPTY_DISCLOSURE_KEYS,
    expandedSessionIds: EMPTY_DISCLOSURE_KEYS
  }
}

// Why: inactive sidebar panels unmount, so renderer-session state preserves transient
// choices across navigation without promoting context-sensitive scope to a setting.
let cachedTransientState = createDefaultTransientState()
const transientStateSubscribers = new Set<() => void>()

function getTransientStateSnapshot(): AiVaultPanelTransientState {
  return cachedTransientState
}

function subscribeToTransientState(subscriber: () => void): () => void {
  transientStateSubscribers.add(subscriber)
  return () => transientStateSubscribers.delete(subscriber)
}

function updateTransientState(
  update: (current: AiVaultPanelTransientState) => AiVaultPanelTransientState
): void {
  const next = update(cachedTransientState)
  if (next === cachedTransientState) {
    return
  }
  cachedTransientState = next
  for (const subscriber of transientStateSubscribers) {
    subscriber()
  }
}

function toggleBoundedDisclosureKey(
  current: ReadonlySet<string>,
  key: string
): ReadonlySet<string> {
  const next = new Set(current)
  if (next.delete(key)) {
    return next
  }

  next.add(key)
  if (next.size > MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES) {
    const oldestKey = next.keys().next().value
    if (oldestKey !== undefined) {
      next.delete(oldestKey)
    }
  }
  return next
}

function selectScope(preferredScope: AiVaultScope): void {
  updateTransientState((current) =>
    current.preferredScope === preferredScope ? current : { ...current, preferredScope }
  )
}

function toggleGroup(key: string): void {
  updateTransientState((current) => ({
    ...current,
    collapsedGroups: toggleBoundedDisclosureKey(current.collapsedGroups, key)
  }))
}

function toggleSessionDetails(sessionId: string): void {
  updateTransientState((current) => ({
    ...current,
    expandedSessionIds: toggleBoundedDisclosureKey(current.expandedSessionIds, sessionId)
  }))
}

export type AiVaultPanelTransientStateControls = {
  scope: AiVaultScope
  collapsedGroups: ReadonlySet<string>
  expandedSessionIds: ReadonlySet<string>
  selectScope: (scope: AiVaultScope) => void
  toggleGroup: (key: string) => void
  toggleSessionDetails: (sessionId: string) => void
}

export function useAiVaultPanelTransientState(args: {
  activeProjectKey: string | null
  activeWorktreePath: string | null
}): AiVaultPanelTransientStateControls {
  // Why: this renderer-session cache outlives any one panel mount, so consumers
  // subscribe through React's external-store contract instead of holding stale copies.
  const rendered = useSyncExternalStore(
    subscribeToTransientState,
    getTransientStateSnapshot,
    getTransientStateSnapshot
  )

  return {
    scope: normalizeAiVaultScopeForContext({
      scope: rendered.preferredScope,
      activeProjectKey: args.activeProjectKey,
      activeWorktreePath: args.activeWorktreePath
    }),
    collapsedGroups: rendered.collapsedGroups,
    expandedSessionIds: rendered.expandedSessionIds,
    selectScope,
    toggleGroup,
    toggleSessionDetails
  }
}

export function clearAiVaultPanelTransientStateForTests(): void {
  updateTransientState(() => createDefaultTransientState())
}
