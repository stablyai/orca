import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultSearchSort,
  type AiVaultSort
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  createDefaultAiVaultViewOptions,
  enabledAiVaultAgents,
  readAiVaultViewOptions,
  writeAiVaultViewOptions,
  AI_VAULT_PINNED_SESSIONS_MAX,
  type AiVaultViewOptions
} from './ai-vault-view-options-persistence'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'

type AiVaultViewOptionsUpdate = (current: AiVaultViewOptions) => AiVaultViewOptions

// Share options between sidebar/resume panels so independent writes cannot undo each other; reread after all unmount.
let mountedOptions: AiVaultViewOptions | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      mountedOptions = null
    }
  }
}

function getOptions(): AiVaultViewOptions {
  mountedOptions ??= readAiVaultViewOptions()
  return mountedOptions
}

function updateOptions(update: AiVaultViewOptionsUpdate): void {
  const current = getOptions()
  const candidate = update(current)
  if (candidate === current) {
    return
  }
  // Setters preserve validity; skip renormalization to retain disabledAgents identity and cached session filtering.
  mountedOptions = candidate
  writeAiVaultViewOptions(candidate)
  for (const listener of listeners) {
    listener()
  }
}

function withAgentEnabled(
  disabledAgents: AiVaultAgent[],
  agent: AiVaultAgent,
  enabled: boolean
): AiVaultAgent[] {
  if (enabled === !disabledAgents.includes(agent)) {
    return disabledAgents
  }
  // Allow zero agents so Clear then selecting one remains possible.
  return enabled ? disabledAgents.filter((entry) => entry !== agent) : [...disabledAgents, agent]
}

function withAllAgentsEnabled(disabledAgents: AiVaultAgent[], enabled: boolean): AiVaultAgent[] {
  const next = enabled ? [] : [...AI_VAULT_AGENTS]
  const unchanged =
    next.length === disabledAgents.length && next.every((agent) => disabledAgents.includes(agent))
  return unchanged ? disabledAgents : next
}

function updateDisabledAgents(update: (disabledAgents: AiVaultAgent[]) => AiVaultAgent[]): void {
  updateOptions((current) => {
    const disabledAgents = update(current.disabledAgents)
    return disabledAgents === current.disabledAgents ? current : { ...current, disabledAgents }
  })
}

/** `localAgents` gives the panel its own agent filter, starting with those agents; it is never saved. */
export function usePersistedAiVaultViewOptions(localAgents?: readonly AiVaultAgent[]): {
  agents: AiVaultAgent[]
  sort: AiVaultSort
  searchSort: AiVaultSearchSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  sessionLimit: AiVaultSessionLimit
  pinnedSessions: readonly string[]
  setSort: (sort: AiVaultSort) => void
  setSearchSort: (sort: AiVaultSearchSort) => void
  setGroup: (group: AiVaultGroup) => void
  setHideEmptySessions: (hide: boolean) => void
  setSessionLimit: (limit: AiVaultSessionLimit) => void
  togglePinnedSession: (id: string) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
  setAllAgentsEnabled: (enabled: boolean) => void
  resetViewOptions: () => void
} {
  // Build batched menu writes on the updated module copy rather than stale rendered options.
  const options = useSyncExternalStore(subscribe, getOptions)

  const setSort = useCallback(
    (sort: AiVaultSort) =>
      updateOptions((current) => (current.sort === sort ? current : { ...current, sort })),
    []
  )
  const setSearchSort = useCallback(
    (searchSort: AiVaultSearchSort) =>
      updateOptions((current) =>
        current.searchSort === searchSort ? current : { ...current, searchSort }
      ),
    []
  )
  const setGroup = useCallback(
    (group: AiVaultGroup) =>
      updateOptions((current) => (current.group === group ? current : { ...current, group })),
    []
  )
  const setHideEmptySessions = useCallback(
    (hideEmptySessions: boolean) =>
      updateOptions((current) =>
        current.hideEmptySessions === hideEmptySessions
          ? current
          : { ...current, hideEmptySessions }
      ),
    []
  )
  const setSessionLimit = useCallback(
    (sessionLimit: AiVaultSessionLimit) =>
      updateOptions((current) =>
        current.sessionLimit === sessionLimit ? current : { ...current, sessionLimit }
      ),
    []
  )
  // Newest pin first so the Pinned group lists recency and the cap drops the oldest.
  const togglePinnedSession = useCallback(
    (id: string) =>
      updateOptions((current) => {
        const without = current.pinnedSessions.filter((pinned) => pinned !== id)
        if (without.length === current.pinnedSessions.length) {
          return {
            ...current,
            pinnedSessions: [id, ...without].slice(0, AI_VAULT_PINNED_SESSIONS_MAX)
          }
        }
        return { ...current, pinnedSessions: without }
      }),
    []
  )
  const [localDisabledAgents, setLocalDisabledAgents] = useState(() =>
    localAgents ? AI_VAULT_AGENTS.filter((agent) => !localAgents.includes(agent)) : null
  )
  const local = localDisabledAgents !== null
  const updateAgents = useCallback(
    (update: (disabledAgents: AiVaultAgent[]) => AiVaultAgent[]) =>
      local
        ? setLocalDisabledAgents((current) => current && update(current))
        : updateDisabledAgents(update),
    [local]
  )
  const setAgentEnabled = useCallback(
    (agent: AiVaultAgent, enabled: boolean) =>
      updateAgents((disabled) => withAgentEnabled(disabled, agent, enabled)),
    [updateAgents]
  )
  const setAllAgentsEnabled = useCallback(
    (enabled: boolean) => updateAgents((disabled) => withAllAgentsEnabled(disabled, enabled)),
    [updateAgents]
  )
  const resetViewOptions = useCallback(() => {
    updateOptions((current) => ({
      ...createDefaultAiVaultViewOptions(),
      pinnedSessions: current.pinnedSessions,
      ...(local ? { disabledAgents: current.disabledAgents } : {})
    }))
    if (local) {
      setLocalDisabledAgents([])
    }
  }, [local])

  const disabledAgents = localDisabledAgents ?? options.disabledAgents
  const agents = useMemo(() => enabledAiVaultAgents(disabledAgents), [disabledAgents])
  return {
    agents,
    sort: options.sort,
    searchSort: options.searchSort,
    group: options.group,
    hideEmptySessions: options.hideEmptySessions,
    sessionLimit: options.sessionLimit,
    pinnedSessions: options.pinnedSessions,
    setSort,
    setSearchSort,
    setGroup,
    setHideEmptySessions,
    setSessionLimit,
    togglePinnedSession,
    setAgentEnabled,
    setAllAgentsEnabled,
    resetViewOptions
  }
}
