import { useCallback, useMemo, useRef, useState } from 'react'
import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import {
  createDefaultAiVaultViewOptions,
  enabledAiVaultAgents,
  readAiVaultViewOptions,
  writeAiVaultViewOptions,
  type AiVaultViewOptions
} from './ai-vault-view-options-persistence'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

type AiVaultViewOptionsUpdate = (current: AiVaultViewOptions) => AiVaultViewOptions

export function usePersistedAiVaultViewOptions(): {
  agents: AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  sessionLimit: AiVaultSessionLimit
  setSort: (sort: AiVaultSort) => void
  setGroup: (group: AiVaultGroup) => void
  setHideEmptySessions: (hide: boolean) => void
  setSessionLimit: (limit: AiVaultSessionLimit) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
  setAllAgentsEnabled: (enabled: boolean) => void
  resetViewOptions: () => void
} {
  const [options, setOptions] = useState<AiVaultViewOptions>(() => readAiVaultViewOptions())
  // Why: menu actions may batch before a render, so every persistence write must build on
  // the immediately preceding action instead of the last rendered options.
  const optionsRef = useRef(options)

  const updateOptions = useCallback((update: AiVaultViewOptionsUpdate) => {
    const current = optionsRef.current
    const candidate = update(current)
    if (candidate === current) {
      return
    }
    // Why: setters map valid state to valid state, so persist the candidate directly.
    // Re-normalizing here would re-allocate disabledAgents on every sort/group change and
    // needlessly recompute the session filter; writeAiVaultViewOptions still normalizes what it stores.
    optionsRef.current = candidate
    setOptions(candidate)
    writeAiVaultViewOptions(candidate)
  }, [])

  const setSort = useCallback(
    (sort: AiVaultSort) =>
      updateOptions((current) => (current.sort === sort ? current : { ...current, sort })),
    [updateOptions]
  )
  const setGroup = useCallback(
    (group: AiVaultGroup) =>
      updateOptions((current) => (current.group === group ? current : { ...current, group })),
    [updateOptions]
  )
  const setHideEmptySessions = useCallback(
    (hideEmptySessions: boolean) =>
      updateOptions((current) =>
        current.hideEmptySessions === hideEmptySessions
          ? current
          : { ...current, hideEmptySessions }
      ),
    [updateOptions]
  )
  const setSessionLimit = useCallback(
    (sessionLimit: AiVaultSessionLimit) =>
      updateOptions((current) =>
        current.sessionLimit === sessionLimit ? current : { ...current, sessionLimit }
      ),
    [updateOptions]
  )
  const setAgentEnabled = useCallback(
    (agent: AiVaultAgent, enabled: boolean) => {
      updateOptions((current) => {
        const isDisabled = current.disabledAgents.includes(agent)
        if (enabled === !isDisabled) {
          return current
        }
        // Why: allow zero enabled agents so Clear + re-check one agent is a two-step filter.
        const disabledAgents = enabled
          ? current.disabledAgents.filter((entry) => entry !== agent)
          : [...current.disabledAgents, agent]
        return { ...current, disabledAgents }
      })
    },
    [updateOptions]
  )
  const setAllAgentsEnabled = useCallback(
    (enabled: boolean) => {
      updateOptions((current) => {
        const disabledAgents = enabled ? [] : [...AI_VAULT_AGENTS]
        if (
          disabledAgents.length === current.disabledAgents.length &&
          disabledAgents.every((agent) => current.disabledAgents.includes(agent))
        ) {
          return current
        }
        return { ...current, disabledAgents }
      })
    },
    [updateOptions]
  )
  const resetViewOptions = useCallback(
    () => updateOptions(() => createDefaultAiVaultViewOptions()),
    [updateOptions]
  )

  const agents = useMemo(
    () => enabledAiVaultAgents(options.disabledAgents),
    [options.disabledAgents]
  )
  return {
    agents,
    sort: options.sort,
    group: options.group,
    hideEmptySessions: options.hideEmptySessions,
    sessionLimit: options.sessionLimit,
    setSort,
    setGroup,
    setHideEmptySessions,
    setSessionLimit,
    setAgentEnabled,
    setAllAgentsEnabled,
    resetViewOptions
  }
}
