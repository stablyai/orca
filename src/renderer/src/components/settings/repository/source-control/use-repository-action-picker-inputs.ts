import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { sourceControlRepoAgentRows } from '@/lib/source-control-agent-picker'
import { canSaveSourceControlActionSurface } from '../../SourceControlActionAgentPicker'
import { SOURCE_CONTROL_ACTION_IDS } from '../../../../../../shared/source-control-ai-actions'
import { invalidateAgentPickerDrafts } from '../../../agent/AgentLaunchSetupButton'
import {
  useSourceControlActionAgent,
  useSourceControlActionAgentInventory
} from '../../use-source-control-action-agent'
import type { RepositorySourceControlAiActionRowsProps } from './repository-source-control-ai-action-rows-props'

export function useRepositoryActionPickerInputs(props: RepositorySourceControlAiActionRowsProps) {
  const { repoId, defaultTuiAgent } = props
  const draftScopes = useMemo(
    () => new Map(SOURCE_CONTROL_ACTION_IDS.map((id) => [id, { repoId }])),
    [repoId]
  )
  useEffect(() => () => draftScopes.forEach(invalidateAgentPickerDrafts), [draftScopes])
  useSourceControlActionAgentInventory()
  const repo = useAppStore((state) => state.repos.find((repo) => repo.id === repoId) ?? null)
  const rows = sourceControlRepoAgentRows(repo)
  const observation = useAgentMenuObservation(rows.target, true, rows.detectionTarget)
  const canSaveSurface = canSaveSourceControlActionSurface(rows.target)
  const resolveAgent = useSourceControlActionAgent(null, defaultTuiAgent ?? null).resolve
  const current = useRef({ props, resolveAgent })
  useLayoutEffect(() => {
    current.current = { props, resolveAgent }
  })
  const resolve = useCallback(
    (agent: Parameters<typeof resolveAgent>[0]) => current.current.resolveAgent(agent),
    []
  )
  const actions = useMemo(
    () => ({
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
  return { ...actions, draftScopes, observation, canSaveSurface, resolveAgent: resolve }
}
