import { describe, expect, it } from 'vitest'
import { buildSidebarRowPlan } from './worktree-list/grouping/build-rows.test-fixture'
import { getSidebarOrderedRepoHeaderIdsByBucket } from './project-header-drop'
import { repo, worktree, project } from './worktree-list-groups-test-fixtures'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

// One durable project set up on this Orca's own host and on a paired host; the paired host's
// row was moved into that host's group from the paired host's own window.
const pairedHostId = 'runtime:laptop-a'
const pairedGroup: ProjectGroup = {
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
const localGroup: ProjectGroup = {
  ...pairedGroup,
  id: 'group-local',
  name: 'This Mac',
  executionHostId: 'local',
  tabOrder: 1
}
const localRepo: Repo = { ...repo, projectGroupId: null }
const pairedRepo: Repo = {
  ...repo,
  id: 'repo-a',
  path: '/Users/a/orca',
  executionHostId: pairedHostId,
  projectGroupId: pairedGroup.id,
  projectGroupOrder: 0
}
const localWorktree: Worktree = { ...worktree, lastActivityAt: 2 }
const pairedWorktree: Worktree = {
  ...worktree,
  id: 'wt-a',
  repoId: pairedRepo.id,
  path: '/Users/a/orca-feature',
  hostId: pairedHostId,
  lastActivityAt: 1
}

// The paired host's own Orca lists its row first; this Orca lists its local row first.
const PAIRED_HOST_ORDER = new Map([
  [pairedRepo.id, 0],
  [localRepo.id, 1]
])
const THIS_ORCA_ORDER = new Map([
  [localRepo.id, 0],
  [pairedRepo.id, 1]
])

function planRows(args: {
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

function headerKeys(args: Parameters<typeof planRows>[0]): string[] {
  return planRows(args)
    .render(new Set())
    .filter((row) => row.type === 'header')
    .map((row) => `${row.key}@${row.projectGroupDepth ?? 0}`)
}

describe('a project grouped on one of its hosts', () => {
  it('lands in the same group whichever host row anchors the merged project header', () => {
    const onPairedHost = headerKeys({ repoOrder: PAIRED_HOST_ORDER })
    const onThisOrca = headerKeys({ repoOrder: THIS_ORCA_ORDER })

    expect(onPairedHost).toEqual(['project-group:group-a@0', 'project:github:stablyai/orca@1'])
    expect(onThisOrca).toEqual(onPairedHost)
  })

  it('reveals the project through the group it is drawn in', () => {
    const section = planRows({ repoOrder: THIS_ORCA_ORDER }).occurrencePlan.sections.find(
      (entry) => entry.key === `project:${project.id}`
    )

    expect(section?.revealPath?.parent?.key).toBe('project-group:group-a')
  })

  it("keeps the anchor's own group when the hosts' rows sit in different groups", () => {
    const groupedLocal: Repo = { ...localRepo, projectGroupId: localGroup.id, projectGroupOrder: 0 }

    expect(
      headerKeys({
        repoOrder: THIS_ORCA_ORDER,
        local: groupedLocal,
        groups: [pairedGroup, localGroup]
      })
    ).toEqual([
      'project-group:group-a@0',
      'project-group:group-local@0',
      'project:github:stablyai/orca@1'
    ])
    const rows = planRows({
      repoOrder: THIS_ORCA_ORDER,
      local: groupedLocal,
      groups: [pairedGroup, localGroup]
    }).render(new Set())
    const projectIndex = rows.findIndex(
      (row) => row.type === 'header' && row.key === `project:${project.id}`
    )
    const localGroupIndex = rows.findIndex(
      (row) => row.type === 'header' && row.key === 'project-group:group-local'
    )
    expect(projectIndex).toBeGreaterThan(localGroupIndex)
  })

  it('stays at the root while the paired group metadata has not arrived', () => {
    expect(headerKeys({ repoOrder: THIS_ORCA_ORDER, groups: [] })).toEqual([
      'project:github:stablyai/orca@0'
    ])
  })

  it("stays in the group while the grouped host's only workspace is pinned", () => {
    const pinned = { ...pairedWorktree, isPinned: true }

    expect(
      headerKeys({ repoOrder: THIS_ORCA_ORDER, worktrees: [localWorktree, pinned] }).filter(
        (key) => !key.startsWith('pinned')
      )
    ).toEqual(['project-group:group-a@0', 'project:github:stablyai/orca@1'])
  })

  it('places the project the same way with or without an empty-project placeholder', () => {
    // The mounted sidebar passes empty repos as placeholders; Cmd+1–9 ordering passes none.
    const rendered = headerKeys({
      repoOrder: THIS_ORCA_ORDER,
      worktrees: [localWorktree],
      placeholderRepoIds: new Set([pairedRepo.id])
    })
    const shortcutOrder = headerKeys({ repoOrder: THIS_ORCA_ORDER, worktrees: [localWorktree] })

    expect(rendered).toEqual(['project-group:group-a@0', 'project:github:stablyai/orca@1'])
    expect(shortcutOrder).toEqual(rendered)
  })

  it('places competing groups the same way with or without an empty-project placeholder', () => {
    // This Orca's own row ranks first but has no workspaces yet; it sits in another group.
    const emptyLocal: Repo = { ...localRepo, projectGroupId: localGroup.id, projectGroupOrder: 0 }
    const args = {
      repoOrder: THIS_ORCA_ORDER,
      local: emptyLocal,
      groups: [pairedGroup, localGroup],
      worktrees: [pairedWorktree]
    }
    const rendered = headerKeys({ ...args, placeholderRepoIds: new Set([emptyLocal.id]) })
    const shortcutOrder = headerKeys(args)

    expect(rendered).toEqual([
      'project-group:group-a@0',
      'project-group:group-local@0',
      'project:github:stablyai/orca@1'
    ])
    expect(shortcutOrder).toEqual(rendered)
  })

  it('drags the project with the group it is drawn in, as the row that placed it', () => {
    const rows = planRows({ repoOrder: THIS_ORCA_ORDER }).render(new Set())
    const header = rows.find((row) => row.type === 'header' && row.key === `project:${project.id}`)

    expect(header?.type === 'header' ? header.projectGroupRepo?.id : undefined).toBe(pairedRepo.id)
    expect(getSidebarOrderedRepoHeaderIdsByBucket(rows).get(`group:${pairedGroup.id}`)).toEqual([
      localRepo.id
    ])
  })
})
