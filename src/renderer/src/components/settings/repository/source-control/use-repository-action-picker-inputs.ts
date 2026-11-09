import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { sourceControlRepoAgentRows } from '@/lib/source-control/ai/source-control-agent-picker'
import { canSaveSourceControlActionSurface } from '../../source-control/SourceControlActionAgentPicker'
import { SOURCE_CONTROL_ACTION_IDS } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { invalidateAgentPickerDrafts } from '../../../agent/agent-launch-picker-drafts'
import { useSourceControlActionAgentInventory } from '../../source-control/use-source-control-action-agent'
import { readNativeDetectedAgents } from '@/store/slices/agent-inventory/local-detected-agent-store-state'
import type { RepositorySourceControlAiActionRowsProps } from './repository-source-control-ai-action-rows-props'

export function useRepositoryActionPickerInputs(props: RepositorySourceControlAiActionRowsProps) {
  const { repoId, repo } = props
  const draftScopes = useMemo(
    () => new Map(SOURCE_CONTROL_ACTION_IDS.map((id) => [id, { repoId }])),
    [repoId]
  )
  useEffect(() => () => draftScopes.forEach(invalidateAgentPickerDrafts), [draftScopes])
  useSourceControlActionAgentInventory()
  const rows = sourceControlRepoAgentRows(repo)
  const observation = useAgentMenuObservation(rows.target, true, rows.detectionTarget)
  const canSaveSurface = canSaveSourceControlActionSurface(rows.target)
  const nativeDetectedAgents = useAppStore(readNativeDetectedAgents)
  const disabledAgents = useAppStore((state) => state.settings?.disabledTuiAgents)
  // The row list is memoized. These are what the closed "(CLI)" label reads besides the saved surface.
  const agentDefaultSurface = useAppStore((state) => state.settings?.agentDefaultSurface)
  const nativeChatProviders = useAppStore((state) => state.settings?.nativeChatProviders)
  const current = useRef({ props })
  useLayoutEffect(() => {
    current.current = { props }
  })
  const actions = useMemo(
    () => ({
      onActionTextModelChoice: (
        ...args: Parameters<
          NonNullable<RepositorySourceControlAiActionRowsProps['onActionTextModelChoice']>
        >
      ) => current.current.props.onActionTextModelChoice?.(...args),
      onActionModeChange: (
        ...args: Parameters<RepositorySourceControlAiActionRowsProps['onActionModeChange']>
      ) => current.current.props.onActionModeChange(...args),
      onActionAgentChange: (
        ...args: Parameters<RepositorySourceControlAiActionRowsProps['onActionAgentChange']>
      ) => current.current.props.onActionAgentChange(...args),
      onActionLaunchPreferencesChange: (
        ...args: Parameters<
          RepositorySourceControlAiActionRowsProps['onActionLaunchPreferencesChange']
        >
      ) => current.current.props.onActionLaunchPreferencesChange(...args),
      onActionTemplateChange: (
        ...args: Parameters<RepositorySourceControlAiActionRowsProps['onActionTemplateChange']>
      ) => current.current.props.onActionTemplateChange(...args),
      onActionAgentArgsChange: (
        ...args: Parameters<RepositorySourceControlAiActionRowsProps['onActionAgentArgsChange']>
      ) => current.current.props.onActionAgentArgsChange(...args),
      onAppendVariable: (
        ...args: Parameters<RepositorySourceControlAiActionRowsProps['onAppendVariable']>
      ) => current.current.props.onAppendVariable(...args),
      onActionDiscard: (
        ...args: Parameters<RepositorySourceControlAiActionRowsProps['onActionDiscard']>
      ) => current.current.props.onActionDiscard(...args),
      onActionSave: (
        ...args: Parameters<RepositorySourceControlAiActionRowsProps['onActionSave']>
      ) => current.current.props.onActionSave(...args)
    }),
    []
  )
  return {
    ...actions,
    draftScopes,
    observation,
    canSaveSurface,
    nativeDetectedAgents,
    disabledAgents,
    agentDefaultSurface,
    nativeChatProviders
  }
}
