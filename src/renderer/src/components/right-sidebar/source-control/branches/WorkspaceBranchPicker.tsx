import { useCallback, useMemo, type ReactNode } from 'react'
import { toast } from 'sonner'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { getActiveWorkspaceExecutionHostId } from '@/lib/active-workspace-host'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import {
  getExecutionHostLabel,
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { selectWorktreeAgentActivitySummary } from '@/components/sidebar/workspace-card/activity/worktree-agent-activity-summary'
import type { BranchWorkspace } from './branch-picker-rows'
import { BranchPicker } from './BranchPicker'

const NO_ENTRIES: GitStatusEntry[] = []

export type WorkspaceBranchPickerProps = {
  worktreeId: string
  worktreePath: string
  hostId: ExecutionHostId
  repoId: string
  target: RuntimeClientTarget
  branch: string
  /** Replaces the generic agent notice, e.g. when the working agent is this chat's own. */
  agentNotice?: string
  trigger?: ReactNode
  onOpen?: () => void
  onCopyBranch?: () => void
  /** Runs after every landed switch. */
  onLanded: () => void
}

/** One workspace's branch picker; every surface that switches branches in place renders this. */
export function WorkspaceBranchPicker({
  worktreeId,
  worktreePath,
  hostId,
  repoId,
  target,
  branch,
  agentNotice,
  trigger,
  onOpen,
  onCopyBranch,
  onLanded
}: WorkspaceBranchPickerProps) {
  const t = useTranslate()
  // Status slots are keyed by id alone, so while another host's copy of this id is selected they hold its status.
  const otherCopySelected = useAppStore((state) => {
    const selected = getActiveWorkspaceExecutionHostId(state, worktreeId)
    return selected !== null && (parseRoutableExecutionHostId(selected)?.id ?? selected) !== hostId
  })
  const statusRead = useAppStore(
    (state) => state.gitStatusHeadByWorktree?.[worktreeId] !== undefined
  )
  const statusKnown = statusRead && !otherCopySelected
  const readError = useAppStore((state) => state.gitStatusReadErrorByWorktree?.[worktreeId])
  const statusReadError = otherCopySelected ? undefined : readError
  const conflictOperation = useAppStore(
    (state) => state.gitConflictOperationByWorktree[worktreeId] ?? 'unknown'
  )
  const entries = useAppStore((state) => state.gitStatusByWorktree[worktreeId] ?? NO_ENTRIES)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const environmentName = useMemo(
    () =>
      environmentId
        ? runtimeEnvironments.find((host) => host.id === environmentId)?.name
        : undefined,
    [environmentId, runtimeEnvironments]
  )
  // Workspace rows need every worktree, not a folder section's owner-only map.
  const worktreeMap = useAppStore((state) => getIndexedWorktreeMap(selectWorktreesByRepo(state)))
  const agentWorking = useAppStore(
    (state) => selectWorktreeAgentActivitySummary(state, worktreeId).hasLiveWorking
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
  const hostLabel = environmentName ?? getExecutionHostLabel(hostId)
  // Worktree ids repeat across hosts, so a remote copy is named with its host.
  const workspaceLabel =
    hostId === 'local' ? basename(worktreePath) : `${basename(worktreePath)} (${hostLabel})`
  const onSwitched = useCallback(
    (message?: string) => {
      if (message) {
        // The switch can land after the user moved on; name the workspace it happened in.
        const state = useAppStore.getState()
        const selected =
          state.activeWorktreeId === worktreeId &&
          (state.activeWorkspaceExecutionHostId ?? 'local') === hostId
        if (selected) {
          toast.warning(message, { duration: 15000 })
        } else {
          toast.warning(
            translate('sourceControl.branchPicker.switchedIn', 'In {{workspace}}', {
              workspace: workspaceLabel
            }),
            { description: message, duration: 15000 }
          )
        }
      }
      onLanded()
    },
    [worktreeId, hostId, workspaceLabel, onLanded]
  )
  // Checking out moves HEAD under the agent, so creating a branch waits too; the host re-checks on switch.
  const blocker = agentWorking
    ? (agentNotice ??
      t(
        'sourceControl.branchPicker.agentWorking',
        'An agent is working in this workspace. Switch branches after it finishes, or close its tab if it has stopped.'
      ))
    : statusReadError
      ? t(
          'sourceControl.branchPicker.statusFailed',
          "Orca couldn't read this checkout's changes. Refresh Source Control before switching."
        )
      : !statusKnown
        ? t(
            'sourceControl.branchPicker.statusUnknown',
            'Read this checkout’s changes before switching.'
          )
        : conflictOperation !== 'unknown'
          ? t(
              'sourceControl.branchPicker.conflict',
              'Finish or abort the {{operation}} before switching branches.',
              { operation: conflictOperation }
            )
          : entries.length
            ? t(
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
      key={`${hostId}:${worktreeId}`}
      branch={branch}
      blocker={blocker}
      dirtyOnlyBlocker={showDirtyBlocker && !agentWorking}
      trigger={trigger}
      onOpen={otherCopySelected ? undefined : onOpen}
      onCopyBranch={onCopyBranch}
      context={{ target, worktreeId, worktreePath }}
      repoId={repoId}
      hostId={hostId}
      hostLabel={hostLabel}
      workspaceLabel={workspaceLabel}
      workspaces={worktreeMap}
      onOpenWorkspace={onOpenWorkspace}
      onSwitched={onSwitched}
    />
  )
}
