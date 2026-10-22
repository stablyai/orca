import type { AppState } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { getLiveAgentStatusByWorktreeId } from '@/lib/worktree-activity-state'
import { tabHasLivePty } from '../../../../shared/tab-has-live-pty'
import { getWorktreeIdsWithStructuredChat } from '@/components/sidebar/visible-worktree-activity-inputs'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  isIdleWorkspaceActivity,
  type WorkspaceActivityFacts
} from '../../../../shared/sidebar-list/workspace-activity-facts'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/** The window's own activity facts, from the same store slices the sidebar filter reads. */
export function readWindowWorkspaceActivityFacts(
  state: Pick<
    AppState,
    | 'tabsByWorktree'
    | 'ptyIdsByTabId'
    | 'browserTabsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'agentStatusByPaneKey'
  > &
    Partial<Pick<AppState, 'structuredChatSleptAtByPaneKey'>>,
  now: number
): Map<string, WorkspaceActivityFacts> {
  const structuredChatIds = getWorktreeIdsWithStructuredChat(
    state.unifiedTabsByWorktree,
    state.structuredChatSleptAtByPaneKey
  )
  const agentById = getLiveAgentStatusByWorktreeId(
    state.agentStatusByPaneKey,
    state.tabsByWorktree,
    now
  )
  const ids = new Set([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.browserTabsByWorktree),
    ...structuredChatIds,
    ...agentById.keys()
  ])
  const facts = new Map<string, WorkspaceActivityFacts>()
  for (const id of ids) {
    const fact: WorkspaceActivityFacts = {
      terminal: (state.tabsByWorktree[id] ?? []).some((tab) =>
        tabHasLivePty(state.ptyIdsByTabId, tab.id)
      )
        ? 'live'
        : null,
      browser: (state.browserTabsByWorktree[id]?.length ?? 0) > 0,
      structuredChat: structuredChatIds.has(id),
      agent: agentById.get(id) ?? null
    }
    if (!isIdleWorkspaceActivity(fact)) {
      facts.set(id, fact)
    }
  }
  return facts
}

// The local runtime answers for the rows it owns; a paired server publishes its own rows' facts.
// The window keys activity by bare id, so an id a paired server also lists cannot be attributed
// to one host and is left out; an id with no owner in the catalog is no row.
export function toLocallyOwnedRows<Value>(
  state: AppState,
  values: ReadonlyMap<string, Value>
): Map<string, Value> {
  const repoById = getRepoMapFromState(state)
  const ownersById = new Map<string, Set<'local' | 'server'>>()
  const own = (id: string, owner: ExecutionHostId | null | undefined): void => {
    if (owner) {
      const owners = ownersById.get(id) ?? new Set()
      owners.add(parseExecutionHostId(owner)?.kind === 'runtime' ? 'server' : 'local')
      ownersById.set(id, owners)
    }
  }
  for (const worktree of getAllWorktreesFromState(state)) {
    const repo = repoById.get(worktree.repoId)
    own(worktree.id, worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : null))
  }
  for (const folder of selectFolderWorkspaces(state) ?? []) {
    own(folderWorkspaceKey(folder.id), getRepoExecutionHostId(folder))
  }
  const scoped = new Map<string, Value>()
  for (const [id, value] of values) {
    const owners = ownersById.get(id)
    if (owners?.has('local') && !owners.has('server')) {
      scoped.set(id, value)
    }
  }
  return scoped
}
