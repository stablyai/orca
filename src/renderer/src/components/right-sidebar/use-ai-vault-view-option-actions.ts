import { useCallback } from 'react'
import type { AiVaultAgent, AiVaultGroup, AiVaultSort } from '../../../../shared/ai-vault-types'
import {
  cloneDefaultAiVaultViewOptions,
  enabledAiVaultAgents,
  type AiVaultViewOptions
} from '../../../../shared/ai-vault-view-options'

// The AI Vault view-menu handlers, each persisting through setOptions. The agent
// toggle edits the disable-list (see AiVaultViewOptions) and keeps at least one
// agent enabled.
export function useAiVaultViewOptionActions(
  options: AiVaultViewOptions,
  setOptions: (next: AiVaultViewOptions) => void
): {
  setSort: (sort: AiVaultSort) => void
  setGroup: (group: AiVaultGroup) => void
  setHideEmptySessions: (hide: boolean) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
  resetViewOptions: () => void
} {
  const setSort = useCallback(
    (sort: AiVaultSort) => setOptions({ ...options, sort }),
    [options, setOptions]
  )

  const setGroup = useCallback(
    (group: AiVaultGroup) => setOptions({ ...options, group }),
    [options, setOptions]
  )

  const setHideEmptySessions = useCallback(
    (hide: boolean) => setOptions({ ...options, hideEmptySessions: hide }),
    [options, setOptions]
  )

  const setAgentEnabled = useCallback(
    (agent: AiVaultAgent, enabled: boolean) => {
      const disabled = options.disabledAgents
      const isDisabled = disabled.includes(agent)
      // Already in the desired state → nothing to persist.
      if (enabled === !isDisabled) {
        return
      }
      const nextDisabled = enabled
        ? disabled.filter((entry) => entry !== agent)
        : [...disabled, agent]
      // Keep at least one agent enabled.
      if (enabledAiVaultAgents(nextDisabled).length === 0) {
        return
      }
      setOptions({ ...options, disabledAgents: nextDisabled })
    },
    [options, setOptions]
  )

  const resetViewOptions = useCallback(
    () => setOptions(cloneDefaultAiVaultViewOptions()),
    [setOptions]
  )

  return { setSort, setGroup, setHideEmptySessions, setAgentEnabled, resetViewOptions }
}
