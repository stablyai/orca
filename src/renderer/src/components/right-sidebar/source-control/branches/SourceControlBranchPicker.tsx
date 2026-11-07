import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getExecutionHostLabel } from '../../../../../../shared/execution-host'
import { selectWorktreeAgentActivitySummary } from '@/components/sidebar/workspace-card/activity/worktree-agent-activity-summary'
import type { BranchWorkspace } from './branch-picker-rows'
import { BranchPicker } from './BranchPicker'
import type { SourceControlPanelModel } from '../panel/use-panel-model'
import { requireGitOwnerTarget } from '../sync/worktree-git-owner-target'

export function SourceControlBranchPicker({ model }: { model: SourceControlPanelModel }) {
  const {
    activeWorktree,
    activeWorktreeId,
    activeRepoTarget,
    activeRepo,
    branchName,
    entries,
    conflictOperation,
    statusReadError,
    worktreeMap,
    recordBranchSwitchOutcome,
    refreshActiveGitStatusAfterMutation
  } = model
  const statusKnown = useAppStore((state) =>
    activeWorktreeId ? state.gitStatusHeadByWorktree?.[activeWorktreeId] !== undefined : false
  )
  const hostLabel = useAppStore((state) =>
    activeRepoTarget?.kind === 'environment'
      ? state.runtimeEnvironments.find((host) => host.id === activeRepoTarget.environmentId)?.name
      : undefined
  )
  const agentWorking = useAppStore((state) =>
    activeWorktreeId
      ? selectWorktreeAgentActivitySummary(state, activeWorktreeId).hasLiveWorking
      : false
  )
  const showDirtyBlocker =
    statusKnown && !statusReadError && conflictOperation === 'unknown' && entries.length > 0
  const changedCount = useMemo(
    () => (showDirtyBlocker ? new Set(entries.map((entry) => entry.path)).size : 0),
    [entries, showDirtyBlocker]
  )
  const onOpenWorkspace = useCallback(
    (workspace: BranchWorkspace) =>
      useAppStore.getState().setActiveWorktree(workspace.id, workspace.hostId),
    []
  )
  const activeWorktreePath = activeWorktree?.path
  const onSwitched = useCallback(
    (message?: string) => {
      if (message) {
        // The switch can land after the user moved on; name the workspace it happened in.
        if (useAppStore.getState().activeWorktreeId === activeWorktreeId) {
          toast.warning(message, { duration: 15000 })
        } else {
          toast.warning(
            translate('sourceControl.branchPicker.switchedIn', 'In {{workspace}}', {
              workspace: basename(activeWorktreePath ?? '')
            }),
            { description: message, duration: 15000 }
          )
        }
      }
      if (activeWorktreeId) {
        recordBranchSwitchOutcome(activeWorktreeId, refreshActiveGitStatusAfterMutation)
      }
    },
    [
      activeWorktreeId,
      activeWorktreePath,
      recordBranchSwitchOutcome,
      refreshActiveGitStatusAfterMutation
    ]
  )
  if (!activeWorktree || !activeWorktreeId || !activeRepo || !activeRepoTarget) {
    return null
  }
  // Checking out moves HEAD under the agent, so creating a branch waits too; the host re-checks on switch.
  const blocker = agentWorking
    ? translate(
        'sourceControl.branchPicker.agentWorking',
        'An agent is working in this workspace. Switch branches after it finishes, or close its tab if it has stopped.'
      )
    : statusReadError
      ? translate(
          'sourceControl.branchPicker.statusFailed',
          "Orca couldn't read this checkout's changes. Refresh Source Control before switching."
        )
      : !statusKnown
        ? translate(
            'sourceControl.branchPicker.statusUnknown',
            'Read this checkout’s changes before switching.'
          )
        : conflictOperation !== 'unknown'
          ? translate(
              'sourceControl.branchPicker.conflict',
              'Finish or abort the {{operation}} before switching branches.',
              { operation: conflictOperation }
            )
          : entries.length
            ? translate(
                'sourceControl.branchPicker.dirty',
                'Commit or discard {{count}} changed files before switching branches.',
                {
                  count: changedCount,
                  defaultValue_one:
                    'Commit or discard {{count}} changed file before switching branches.'
                }
              )
            : null
  return (
    <BranchPicker
      key={`${activeWorktree.hostId}:${activeWorktreeId}`}
      branch={branchName}
      blocker={blocker}
      dirtyOnlyBlocker={showDirtyBlocker && !agentWorking}
      context={{
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktree.path
      }}
      repoId={activeRepo.id}
      hostId={activeWorktree.hostId ?? 'local'}
      hostLabel={hostLabel ?? getExecutionHostLabel(activeWorktree.hostId ?? 'local')}
      workspaces={worktreeMap}
      onOpenWorkspace={onOpenWorkspace}
      onSwitched={onSwitched}
    />
  )
}
