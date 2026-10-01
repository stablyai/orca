import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import { getProjectedWorktreeLineageChildrenByParentId } from '@/components/sidebar/worktree-lineage-projection'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import type { AppState } from '@/store/types'

export type ChildWorktreeUnreadState = Pick<AppState, 'worktreesByRepo'> &
  Partial<
    Pick<
      AppState,
      'settings' | 'worktreeLineageById' | 'workspaceLineageByChildKey' | 'folderWorkspaces'
    >
  >

const EMPTY_IDENTITIES: ReadonlySet<string> = new Set()
const EMPTY_LINEAGE = {}
const EMPTY_FOLDERS: NonNullable<ChildWorktreeUnreadState['folderWorkspaces']> = []

function collectChildWorktreeIdentities(state: ChildWorktreeUnreadState): ReadonlySet<string> {
  const identities = new Set<string>()
  const byHost = new Map<string, Map<string, Worktree>>()
  for (const worktree of getIndexedAllWorktrees(state.worktreesByRepo)) {
    const host = worktree.hostId ?? ''
    let worktrees = byHost.get(host)
    if (!worktrees) {
      worktrees = new Map()
      byHost.set(host, worktrees)
    }
    worktrees.set(worktree.id, worktree)
  }
  for (const worktrees of byHost.values()) {
    const children = getProjectedWorktreeLineageChildrenByParentId(
      state.worktreeLineageById ?? EMPTY_LINEAGE,
      worktrees
    )
    for (const siblings of children.values()) {
      for (const child of siblings) {
        identities.add(getWorktreeHostIdentity(child))
      }
    }
    for (const child of worktrees.values()) {
      const lineage = state.workspaceLineageByChildKey?.[worktreeWorkspaceKey(child.id)]
      const parent = lineage ? parseWorkspaceKey(lineage.parentWorkspaceKey) : null
      if (parent?.type !== 'folder' || !lineage) {
        continue
      }
      if (lineage.childInstanceId && lineage.childInstanceId !== child.instanceId) {
        continue
      }
      const folder = state.folderWorkspaces?.find((candidate) => {
        const host =
          candidate.executionHostId ??
          (candidate.connectionId
            ? toSshExecutionHostId(candidate.connectionId)
            : LOCAL_EXECUTION_HOST_ID)
        return (
          candidate.id === parent.folderWorkspaceId &&
          !candidate.isArchived &&
          host === (child.hostId ?? LOCAL_EXECUTION_HOST_ID)
        )
      })
      if (folder) {
        identities.add(getWorktreeHostIdentity(child))
      }
    }
  }
  return identities
}

// One shared projection keeps card subscriptions cheap on unrelated store writes.
function createHiddenChildUnreadSelector() {
  let previous: ChildWorktreeUnreadState | undefined
  let identities = EMPTY_IDENTITIES
  return (state: ChildWorktreeUnreadState): ReadonlySet<string> => {
    if (state.settings?.notifications?.showChildWorktreeUnread !== false) {
      return EMPTY_IDENTITIES
    }
    if (
      !previous ||
      previous.worktreesByRepo !== state.worktreesByRepo ||
      previous.worktreeLineageById !== (state.worktreeLineageById ?? EMPTY_LINEAGE) ||
      previous.workspaceLineageByChildKey !== (state.workspaceLineageByChildKey ?? EMPTY_LINEAGE) ||
      previous.folderWorkspaces !== (state.folderWorkspaces ?? EMPTY_FOLDERS)
    ) {
      identities = collectChildWorktreeIdentities(state)
      previous = {
        worktreesByRepo: state.worktreesByRepo,
        worktreeLineageById: state.worktreeLineageById ?? EMPTY_LINEAGE,
        workspaceLineageByChildKey: state.workspaceLineageByChildKey ?? EMPTY_LINEAGE,
        folderWorkspaces: state.folderWorkspaces ?? EMPTY_FOLDERS
      }
    }
    return identities
  }
}

export const selectHiddenChildUnreadIdentities = createHiddenChildUnreadSelector()

export function shouldShowWorktreeUnread(
  state: ChildWorktreeUnreadState,
  worktree: Worktree
): boolean {
  return !selectHiddenChildUnreadIdentities(state).has(getWorktreeHostIdentity(worktree))
}
