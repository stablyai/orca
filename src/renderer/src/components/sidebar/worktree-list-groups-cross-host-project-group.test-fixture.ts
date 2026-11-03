import { buildSidebarRowPlan } from './worktree-list/grouping/build-rows.test-fixture'
import { repo, worktree, project } from './worktree-list-groups-test-fixtures'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

// One durable project set up on this Orca's own host and on a paired host; the paired host's
// row was moved into that host's group from the paired host's own window.
export const pairedHostId = 'runtime:laptop-a'
export const pairedGroup: ProjectGroup = {
  id: 'group-a',
  name: 'Laptop A',
  parentPath: null,
  parentGroupId: null,
  executionHostId: pairedHostId,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
export const localGroup: ProjectGroup = {
  ...pairedGroup,
  id: 'group-local',
  name: 'This Mac',
  executionHostId: 'local',
  tabOrder: 1
}
export const localRepo: Repo = { ...repo, projectGroupId: null }
export const pairedRepo: Repo = {
  ...repo,
  id: 'repo-a',
  path: '/Users/a/orca',
  executionHostId: pairedHostId,
  projectGroupId: pairedGroup.id,
  projectGroupOrder: 0
}
export const localWorktree: Worktree = { ...worktree, lastActivityAt: 2 }
export const pairedWorktree: Worktree = {
  ...worktree,
  id: 'wt-a',
  repoId: pairedRepo.id,
  path: '/Users/a/orca-feature',
  hostId: pairedHostId,
  lastActivityAt: 1
}

// The paired host's own Orca lists its row first; this Orca lists its local row first.
export const PAIRED_HOST_ORDER = new Map([
  [pairedRepo.id, 0],
  [localRepo.id, 1]
])
export const THIS_ORCA_ORDER = new Map([
  [localRepo.id, 0],
  [pairedRepo.id, 1]
])

export function planRows(args: {
  repoOrder: Map<string, number>
  local?: Repo
  paired?: Repo
  groups?: ProjectGroup[]
  worktrees?: Worktree[]
  placeholderRepoIds?: Set<string>
}) {
  const local = args.local ?? localRepo
  const paired = args.paired ?? pairedRepo
  const worktrees = args.worktrees ?? [localWorktree, pairedWorktree]
  const setups: ProjectHostSetup[] = [local, paired].map((entry) => ({
    id: entry.id,
    projectId: project.id,
    hostId: entry.executionHostId ?? 'local',
    repoId: entry.id,
    path: entry.path,
    displayName: entry.displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }))
  return buildSidebarRowPlan(
    'repo',
    worktrees,
    new Map([
      [local.id, local],
      [paired.id, paired]
    ]),
    null,
    new Set(),
    args.repoOrder,
    undefined,
    'manual',
    {},
    new Map(worktrees.map((entry) => [entry.id, entry])),
    false,
    undefined,
    args.groups ?? [pairedGroup],
    args.placeholderRepoIds ?? new Set(),
    new Map(),
    new Map(),
    [],
    { projects: [project], projectHostSetups: setups }
  )
}
