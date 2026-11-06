import { useAppStore } from '@/store'
import { getExecutionHostLabel } from '../../../../../../shared/execution-host'
import { selectWorktreeAgentActivitySummary } from '@/components/sidebar/workspace-card/activity/worktree-agent-activity-summary'
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
    worktreeMap
  } = model
  const statusKnown = useAppStore((state) =>
    activeWorktreeId ? state.gitStatusHeadByWorktree?.[activeWorktreeId] !== undefined : false
  )
  const hostLabel = useAppStore((state) =>
    activeRepoTarget?.kind === 'environment'
      ? state.runtimeEnvironments.find((host) => host.id === activeRepoTarget.environmentId)?.name
      : undefined
  )
  if (!activeWorktree || !activeWorktreeId || !activeRepo || !activeRepoTarget) {
    return null
  }
  const changedCount = new Set(entries.map((entry) => entry.path)).size
  const blocker = statusReadError
    ? "Orca couldn't read this checkout's changes. Refresh Source Control before switching."
    : !statusKnown
      ? 'Read this checkout’s changes before switching.'
      : conflictOperation !== 'unknown'
        ? `Finish or abort the ${conflictOperation} before switching branches.`
        : entries.length
          ? `Commit or discard ${changedCount} changed ${changedCount === 1 ? 'file' : 'files'} before switching branches.`
          : null
  return (
    <BranchPicker
      key={`${activeWorktree.hostId}:${activeWorktreeId}`}
      branch={branchName}
      blocker={blocker}
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
      onOpenWorkspace={(workspace) =>
        useAppStore.getState().setActiveWorktree(workspace.id, workspace.hostId)
      }
      onSwitched={(message) => {
        model.setRemoteActionErrors((previous) => ({
          ...previous,
          [activeWorktreeId]: message ? { kind: 'switch_branch', message, rawError: message } : null
        }))
        void model.refreshActiveGitStatusAfterMutation()
      }}
    />
  )
}

function BranchAgentHint({ worktreeId }: { worktreeId: string }) {
  const busy = useAppStore(
    (state) => selectWorktreeAgentActivitySummary(state, worktreeId).hasLiveWorking
  )
  return busy ? (
    <p className="px-3 py-2 text-xs text-muted-foreground">
      An agent last reported work here. Orca checks whether it is still working when you switch.
    </p>
  ) : null
}
