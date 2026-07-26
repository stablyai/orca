import { useCallback, useMemo, useRef, useState } from 'react'
import type { AiVaultAgent, AiVaultGroup, AiVaultSort } from '../../../../shared/ai-vault-types'
import {
  createDefaultAiVaultViewOptions,
  enabledAiVaultAgents,
  readAiVaultViewOptions,
  writeAiVaultViewOptions,
  type AiVaultViewOptions
} from './ai-vault-view-options-persistence'

type AiVaultViewOptionsUpdate = (current: AiVaultViewOptions) => AiVaultViewOptions

export function usePersistedAiVaultViewOptions(): {
  agents: AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  setSort: (sort: AiVaultSort) => void
  setGroup: (group: AiVaultGroup) => void
  setHideEmptySessions: (hide: boolean) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
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
  const setAgentEnabled = useCallback(
    (agent: AiVaultAgent, enabled: boolean) => {
      updateOptions((current) => {
        const isDisabled = current.disabledAgents.includes(agent)
        if (enabled === !isDisabled) {
          return current
        }
        const disabledAgents = enabled
          ? current.disabledAgents.filter((entry) => entry !== agent)
          : [...current.disabledAgents, agent]
        return enabledAiVaultAgents(disabledAgents).length > 0
          ? { ...current, disabledAgents }
          : current
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
    setSort,
    setGroup,
    setHideEmptySessions,
    setAgentEnabled,
    resetViewOptions
  }
}
