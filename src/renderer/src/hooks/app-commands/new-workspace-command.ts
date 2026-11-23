import { buildLinearWorkspaceSource } from '../../../../shared/new-workspace/workspace-source'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getIndexedWorktreesById } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import { getHeaderCreateWorkspaceTarget } from '@/components/sidebar/worktree-list/rows/header-create-workspace-target'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { WorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import { getLinearIssueWorkspaceName } from '../../../../shared/workspace/naming/workspace-name'
import type { AppState } from '../../store/types'

type NewWorkspaceShortcutSeed = {
  initialRepoId?: string
  initialWorkspaceTarget?: WorkspaceCreationTargetHint
  initialProjectGroupId?: string
}

type NewWorkspaceShortcutModalData = NewWorkspaceShortcutSeed & {
  telemetrySource: 'shortcut'
  prefilledName?: string
  linkedWorkItem?: LinkedWorkItemSummary
}

type ShortcutSeedState = Pick<
  AppState,
  'repos' | 'projectHostSetups' | 'worktreesByRepo' | 'folderWorkspaces' | 'settings'
>

/** The focused sidebar row's create target, seeded the way the project header's + seeds it (#46995). */
function resolveShortcutSeed(
  state: ShortcutSeedState,
  focused: { workspaceId: string; hostIdentity: string } | null
): NewWorkspaceShortcutSeed | null {
  if (!focused) {
    return null
  }
  const scope = parseWorkspaceKey(focused.workspaceId)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
    return folder ? { initialProjectGroupId: folder.projectGroupId } : null
  }
  const rows = getIndexedWorktreesById(state.worktreesByRepo, focused.workspaceId)
  const worktree =
    rows.find((row) => getWorktreeHostIdentity(row) === focused.hostIdentity) ?? rows[0] ?? null
  const repo = worktree
    ? findRepoForHost(state.repos, worktree.repoId, {
        hostId: worktree.hostId ?? null,
        settings: state.settings
      })
    : null
  // A row names one host's copy, so pin its host: the repo id alone can resolve to a twin on another host.
  return repo
    ? {
        initialRepoId: repo.id,
        ...getHeaderCreateWorkspaceTarget(repo, state.repos, state.projectHostSetups)
      }
    : null
}

export function buildNewWorkspaceShortcutModalData(
  state: Pick<AppState, 'activeView' | 'taskPageData'>,
  seed: NewWorkspaceShortcutSeed | null = null
): NewWorkspaceShortcutModalData {
  const seedData = { telemetrySource: 'shortcut' as const, ...seed }
  const linearIssue =
    state.activeView === 'tasks' ? (state.taskPageData.openLinearIssue ?? null) : null
  if (!linearIssue) {
    return seedData
  }

  return {
    ...seedData,
    prefilledName: getLinearIssueWorkspaceName(linearIssue),
    // Cmd+N from a Linear issue mirrors its Start-workspace action with source context.
    linkedWorkItem: buildLinearWorkspaceSource(linearIssue)
  }
}

export function openNewWorkspaceFromShortcut(
  state: Pick<AppState, 'activeModal' | 'activeView' | 'taskPageData' | 'openModal'> &
    ShortcutSeedState,
  focused: { workspaceId: string; hostIdentity: string } | null
): void {
  if (state.activeModal === 'new-workspace-composer') {
    return
  }
  state.openModal(
    'new-workspace-composer',
    buildNewWorkspaceShortcutModalData(state, resolveShortcutSeed(state, focused))
  )
}
