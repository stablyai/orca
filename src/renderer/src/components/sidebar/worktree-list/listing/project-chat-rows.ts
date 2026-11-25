import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import {
  isSingleHostProjectHeader,
  type GroupHeaderRow,
  type ProjectChatsRow,
  type WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { isProjectTreeOn } from '../../../../../../shared/sidebar-list/project-tree-settings'

/** Which of these workspaces have agents, as one stable key; re-reads when any of their agent lists change. */
function useWorkspacesWithAgents(ids: readonly string[]): ReadonlySet<string> {
  const projection = useAppStore((s) => s.agentStatusByPaneKey.projection)
  const joined = ids.join('\n')
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = joined
        .split('\n')
        .filter(Boolean)
        .map((id) => projection.subscribe(`roots\0${id}`, listener))
      return () => offs.forEach((off) => off())
    },
    [projection, joined]
  )
  const snapshot = useCallback(
    () =>
      joined
        .split('\n')
        .filter((id) => id && projection.display.roots(id).length > 0)
        .join('\n'),
    [projection, joined]
  )
  const withAgents = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => new Set(withAgents.split('\n').filter(Boolean)), [withAgents])
}

type ProjectChatRowsArgs = {
  groupBy: WorktreeGroupBy
  collapsedGroups: ReadonlySet<string>
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
}

/** The viewport's rows: the plan's, plus the Tree card style's section lines. */
export function useProjectTreeRows(
  rows: HostSectionRow[],
  { groupBy, collapsedGroups }: Pick<ProjectChatRowsArgs, 'groupBy' | 'collapsedGroups'>
): HostSectionRow[] {
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const enabled = useAppStore((s) => isProjectTreeOn(s.settings))
  const mainIds = useMemo(
    () =>
      rows.flatMap((row) =>
        row.type === 'header' && row.repo
          ? (mainCheckoutOf(row.repo, worktreesByRepo, row.hostId)?.id ?? [])
          : []
      ),
    [rows, worktreesByRepo]
  )
  const withChats = useWorkspacesWithAgents(enabled ? mainIds : [])
  return useMemo(
    () =>
      enabled
        ? withProjectChatRows(rows, { groupBy, collapsedGroups, worktreesByRepo }, withChats)
        : rows,
    [enabled, rows, groupBy, collapsedGroups, worktreesByRepo, withChats]
  )
}

/** Where a project's plain chats run: its main checkout on any branch, which for a folder project is the folder. */
export function isProjectHome(worktree: Worktree): boolean {
  return worktree.isMainWorktree && worktree.ephemeralVmCheckoutMode !== 'provisioned-root'
}

/** The main checkout on this host; a project checked out on several hosts lists each copy. */
export function mainCheckoutOf(
  repo: Repo,
  worktreesByRepo: ProjectChatRowsArgs['worktreesByRepo'],
  hostId: ExecutionHostId | undefined
): Worktree | undefined {
  return worktreesByRepo[repo.id]?.find(
    (worktree) =>
      isProjectHome(worktree) &&
      (hostId === undefined || (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId)
  )
}

function isOpen(row: GroupHeaderRow, collapsedGroups: ReadonlySet<string>): boolean {
  return !collapsedGroups.has(row.collapseKey ?? row.key)
}

/** Adds each open project's Chats, "Worktrees" label and "+ chat / + worktree" line, and a folder group's Chats label. */
export function withProjectChatRows(
  rows: HostSectionRow[],
  { groupBy, collapsedGroups, worktreesByRepo }: ProjectChatRowsArgs,
  mainsWithChats: ReadonlySet<string>
): HostSectionRow[] {
  if (groupBy !== 'repo') {
    return rows
  }
  // Host-qualified: the same project on two hosts has two main checkouts with one id.
  const renderedIds = new Set(
    rows.flatMap((row) => (row.type === 'item' ? [getWorktreeHostIdentity(row.worktree)] : []))
  )
  const out: HostSectionRow[] = []
  // The open project's "Worktrees" label (pushed before its first worktree) and its closing actions line.
  let worktreesLabel: ProjectChatsRow | null = null
  let actions: ProjectChatsRow | null = null
  rows.forEach((row, index) => {
    if (row.type === 'header' || row.type === 'host-header') {
      if (actions) {
        out.push(actions)
      }
      worktreesLabel = actions = null
    } else if (row.type === 'item' && worktreesLabel) {
      out.push(worktreesLabel)
      worktreesLabel = null
    }
    out.push(row)
    if (row.type !== 'header' || !isOpen(row, collapsedGroups)) {
      return
    }
    const groupDepth = row.projectGroupDepth ?? 0
    if (!row.repo) {
      const next = rows[index + 1]
      if (
        row.projectGroup &&
        'parentPath' in row.projectGroup &&
        next?.type === 'folder-workspace'
      ) {
        const projectGroup = row.projectGroup
        out.push({
          type: 'project-chats',
          key: `${row.hostId ?? ''}:${row.key}:chats`,
          // Aligns with the group's session rows below it, which sit at the group's own depth.
          groupDepth,
          section: 'group-chats',
          projectGroup
        })
      }
      return
    }
    const repo = row.repo
    const main = mainCheckoutOf(repo, worktreesByRepo, row.hostId) ?? null
    const base = {
      type: 'project-chats' as const,
      key: `${row.hostId ?? ''}:${row.key}`,
      repo,
      mainWorktree: main,
      groupDepth,
      pinHost: isSingleHostProjectHeader(row)
    }
    // A visible main checkout card already lists its agents; an empty Chats section shows nothing.
    const chatsShown =
      main !== null &&
      !renderedIds.has(getWorktreeHostIdentity(main)) &&
      mainsWithChats.has(main.id)
    if (chatsShown) {
      out.push({ ...base, section: 'chats' })
    }
    worktreesLabel =
      chatsShown && isGitRepoKind(repo)
        ? { ...base, key: `${base.key}:worktrees`, section: 'worktrees' }
        : null
    actions = { ...base, key: `${base.key}:actions`, section: 'actions' }
  })
  if (actions) {
    out.push(actions)
  }
  return out
}
