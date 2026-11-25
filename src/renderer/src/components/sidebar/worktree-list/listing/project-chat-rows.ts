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
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { isProjectTreeOn } from '../../../../../../shared/sidebar-list/project-tree-settings'
import {
  indexHiddenProjects,
  type HiddenProjects
} from '../../../../../../shared/project/catalog/hidden-projects'
import type { SectionRowsArgs } from './sidebar-list-model'

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

/** Where a header's main checkouts come from. */
type ProjectHomes = {
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  isRowHidden: HiddenProjects['isRowHidden']
  /** Each project section's repo ids: one project can span registrations with different ids. */
  sectionRepoIds: ReadonlyMap<string, ReadonlySet<string>>
}

type ProjectChatRowsArgs = ProjectHomes & {
  groupBy: WorktreeGroupBy
  collapsedGroups: ReadonlySet<string>
}

type PlannedSections = {
  occurrencePlan: { sections: readonly { key: string; group: { repoIds: ReadonlySet<string> } }[] }
}

/** The viewport's rows: the plan's, plus the Tree card style's section lines. */
export function useProjectTreeRows(
  rows: HostSectionRow[],
  { groupBy, repos, defaultHostId }: Pick<SectionRowsArgs, 'groupBy' | 'repos' | 'defaultHostId'>,
  collapsedGroups: ReadonlySet<string>,
  { occurrencePlan: { sections } }: PlannedSections
): HostSectionRow[] {
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const enabled = useAppStore((s) => isProjectTreeOn(s.settings))
  // Cached per repos array, so this is the same index the plan used.
  const { isRowHidden } = indexHiddenProjects(repos, defaultHostId)
  const homes = useMemo<ProjectHomes>(
    () => ({
      worktreesByRepo,
      isRowHidden,
      sectionRepoIds: new Map(
        enabled ? sections.map((section) => [section.key, section.group.repoIds]) : []
      )
    }),
    [enabled, worktreesByRepo, isRowHidden, sections]
  )
  // Off, Tree reads nothing: no header's main checkouts are looked up or subscribed to.
  const mainIds = useMemo(
    () =>
      enabled
        ? rows.flatMap((row) =>
            row.type === 'header' && row.repo
              ? headerMainCheckouts(row, row.repo, homes).map((home) => home.id)
              : []
          )
        : [],
    [enabled, rows, homes]
  )
  const withChats = useWorkspacesWithAgents(mainIds)
  return useMemo(
    () =>
      enabled ? withProjectChatRows(rows, { ...homes, groupBy, collapsedGroups }, withChats) : rows,
    [enabled, rows, homes, groupBy, collapsedGroups, withChats]
  )
}

/** Where a project's plain chats run: its main checkout on any branch, which for a folder project is the folder. */
export function isProjectHome(worktree: Worktree): boolean {
  return worktree.isMainWorktree && worktree.ephemeralVmCheckoutMode !== 'provisioned-root'
}

/** The main checkout on this host; a project checked out on several hosts lists each copy. */
export function mainCheckoutOf(
  repo: Repo,
  worktreesByRepo: ProjectHomes['worktreesByRepo'],
  hostId: ExecutionHostId
): Worktree | undefined {
  return worktreesByRepo[repo.id]?.find(
    (worktree) => isProjectHome(worktree) && getWorktreeExecutionHostId(worktree, repo) === hostId
  )
}

/** A project header's host: its host section's, else its own registration's (an all-hosts header's anchor). */
export function headerHostId(hostId: ExecutionHostId | undefined, repo: Repo): ExecutionHostId {
  return hostId ?? getRepoExecutionHostId(repo)
}

/** The main checkouts a header's Chats stand for. An unsplit all-hosts header covers every shown
 * host copy of each repo id in its section, rows or not, so it reads the catalog rather than the
 * hosts its rows happen to sit on. */
function headerMainCheckouts(
  row: GroupHeaderRow,
  repo: Repo,
  { worktreesByRepo, isRowHidden, sectionRepoIds }: ProjectHomes
): Worktree[] {
  if (row.hostId !== undefined) {
    const home = mainCheckoutOf(repo, worktreesByRepo, row.hostId)
    return home ? [home] : []
  }
  return [...(sectionRepoIds.get(row.key) ?? [repo.id])].flatMap(
    (repoId) =>
      worktreesByRepo[repoId]?.filter((home) => isProjectHome(home) && !isRowHidden(home)) ?? []
  )
}

function isOpen(row: GroupHeaderRow, collapsedGroups: ReadonlySet<string>): boolean {
  return !collapsedGroups.has(row.collapseKey ?? row.key)
}

/** Adds each open project's Chats, "Worktrees" label and "+ chat / + worktree" line, and a folder group's Chats label. */
export function withProjectChatRows(
  rows: HostSectionRow[],
  { groupBy, collapsedGroups, ...homes }: ProjectChatRowsArgs,
  mainsWithChats: ReadonlySet<string>
): HostSectionRow[] {
  const { worktreesByRepo } = homes
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
    // "+ chat" starts on the header's host, like "+ worktree".
    const main = mainCheckoutOf(repo, worktreesByRepo, headerHostId(row.hostId, repo)) ?? null
    const base = {
      type: 'project-chats' as const,
      key: `${row.hostId ?? ''}:${row.key}`,
      repo,
      mainWorktree: main,
      groupDepth,
      pinHost: isSingleHostProjectHeader(row)
    }
    // Listing a hidden main checkout's chats is the point of Tree: "Hide default branch" hides the
    // checkout's row, not its chats. A visible one's card already lists them; empty sections hide.
    const chatSources = headerMainCheckouts(row, repo, homes).filter(
      (home) => !renderedIds.has(getWorktreeHostIdentity(home)) && mainsWithChats.has(home.id)
    )
    const chatsShown = chatSources.length > 0
    if (chatsShown) {
      out.push({ ...base, section: 'chats', chatSources })
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
