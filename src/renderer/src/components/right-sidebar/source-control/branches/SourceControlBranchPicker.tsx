import { useCallback, useMemo } from 'react'
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
  const onSwitched = useCallback(
    (message?: string) => {
      if (activeWorktreeId) {
        recordBranchSwitchOutcome(activeWorktreeId, message, refreshActiveGitStatusAfterMutation)
      }
    },
    [activeWorktreeId, recordBranchSwitchOutcome, refreshActiveGitStatusAfterMutation]
  )
  if (!activeWorktree || !activeWorktreeId || !activeRepo || !activeRepoTarget) {
    return null
  }
  const blocker = statusReadError
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
      dirtyOnlyBlocker={showDirtyBlocker}
      agentHint={<BranchAgentHint worktreeId={activeWorktreeId} />}
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

function BranchAgentHint({ worktreeId }: { worktreeId: string }) {
  const busy = useAppStore(
    (state) => selectWorktreeAgentActivitySummary(state, worktreeId).hasLiveWorking
  )
  return busy ? (
    <p className="px-3 py-2 text-xs text-muted-foreground">
      {translate(
        'sourceControl.branchPicker.agentHint',
        'An agent last reported work here. Orca checks whether it is still working when you switch.'
      )}
    </p>
  ) : null
}
