import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SOURCE_CONTROL_CUSTOM_ACTIONS_SECTION_ID } from '@/components/settings/source-control-custom-actions-section'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { SourceControlCustomAction } from '../../../../../shared/source-control-custom-actions'
import { runPullRequestCustomAction } from '../actions/custom-action-launch'

const NO_CUSTOM_ACTIONS: readonly SourceControlCustomAction[] = []

export function usePullRequestCustomActions({
  workItem,
  effectiveRepoId,
  openWorkspaceComposer
}: {
  workItem: GitHubWorkItem | null
  effectiveRepoId: string | null
  openWorkspaceComposer: () => void
}): {
  customActions: readonly SourceControlCustomAction[]
  customActionsBusy: boolean
  onRunCustomAction: (action: SourceControlCustomAction) => void
  onManageCustomActions: () => void
} {
  const customActions =
    useAppStore((s) => s.settings?.sourceControlAi?.customActions) ?? NO_CUSTOM_ACTIONS
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  // Why: a second pick while workspace creation is in flight would start a duplicate agent.
  const runningRef = useRef(false)
  const [customActionsBusy, setCustomActionsBusy] = useState(false)

  const onRunCustomAction = useCallback(
    (action: SourceControlCustomAction): void => {
      if (!workItem || runningRef.current) {
        return
      }
      runningRef.current = true
      setCustomActionsBusy(true)
      void runPullRequestCustomAction({
        action,
        item: workItem,
        repoId: effectiveRepoId,
        openWorkspaceComposer
      })
        .catch((error: unknown) => {
          console.error('Failed to run pull request custom action', error)
          toast.error(
            translate(
              'pullRequestCustomActions.launch.failed',
              'Failed to run "{{value0}}": {{value1}}',
              {
                value0: action.label,
                value1: error instanceof Error ? error.message : String(error)
              }
            )
          )
        })
        .finally(() => {
          runningRef.current = false
          setCustomActionsBusy(false)
        })
    },
    [effectiveRepoId, openWorkspaceComposer, workItem]
  )

  const onManageCustomActions = useCallback((): void => {
    openSettingsTarget({
      pane: 'git',
      repoId: null,
      sectionId: SOURCE_CONTROL_CUSTOM_ACTIONS_SECTION_ID
    })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  return { customActions, customActionsBusy, onRunCustomAction, onManageCustomActions }
}
