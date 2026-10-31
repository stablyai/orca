import { describe, expect, it } from 'vitest'
import { getSidebarOrderedRepoHeaderIdsByBucket } from './project-header-drop'
import { project } from './worktree-list-groups-test-fixtures'
import {
  localGroup,
  localRepo,
  localWorktree,
  PAIRED_HOST_ORDER,
  pairedGroup,
  pairedHostId,
  pairedRepo,
  pairedWorktree,
  planRows,
  THIS_ORCA_ORDER
} from './worktree-list-groups-cross-host-project-group.test-fixture'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'

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
    const section = planRows({
      repoOrder: THIS_ORCA_ORDER
    }).occurrencePlan.sections.find((entry) => entry.key === `project:${project.id}`)

    expect(section?.revealPath?.parent?.key).toBe('project-group:group-a')
  })

  it.each([
    ['this Orca lists its own row first', THIS_ORCA_ORDER, {}],
    ["this Orca lists the paired host's row first", PAIRED_HOST_ORDER, {}],
    ["this Orca's own row is a direct SSH row", PAIRED_HOST_ORDER, { connectionId: 'build-box' }]
  ])(
    "keeps this Orca's own group when the hosts' rows sit in different groups and %s",
    (_, repoOrder, host: Partial<Repo>) => {
      const groupedLocal: Repo = {
        ...localRepo,
        ...host,
        projectGroupId: localGroup.id,
        projectGroupOrder: 0
      }

      expect(
        headerKeys({
          repoOrder,
          local: groupedLocal,
          groups: [pairedGroup, localGroup]
        })
      ).toEqual([
        'project-group:group-a@0',
        'project-group:group-local@0',
        'project:github:stablyai/orca@1'
      ])
      const rows = planRows({
        repoOrder,
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
    }
  )

  it('stays at the root while the paired group metadata has not arrived', () => {
    expect(headerKeys({ repoOrder: THIS_ORCA_ORDER, groups: [] })).toEqual([
      'project:github:stablyai/orca@0'
    ])
  })

  it("stays in the group while the grouped host's only workspace is pinned", () => {
    const pinned = { ...pairedWorktree, isPinned: true }

    expect(
      headerKeys({
        repoOrder: THIS_ORCA_ORDER,
        worktrees: [localWorktree, pinned]
      }).filter((key) => !key.startsWith('pinned'))
    ).toEqual(['project-group:group-a@0', 'project:github:stablyai/orca@1'])
  })

  it('places the project the same way with or without an empty-project placeholder', () => {
    // The mounted sidebar passes empty repos as placeholders; Cmd+1–9 ordering passes none.
    const rendered = headerKeys({
      repoOrder: THIS_ORCA_ORDER,
      worktrees: [localWorktree],
      placeholderRepoIds: new Set([pairedRepo.id])
    })
    const shortcutOrder = headerKeys({
      repoOrder: THIS_ORCA_ORDER,
      worktrees: [localWorktree]
    })

    expect(rendered).toEqual(['project-group:group-a@0', 'project:github:stablyai/orca@1'])
    expect(shortcutOrder).toEqual(rendered)
  })

  it('places competing groups the same way with or without an empty-project placeholder', () => {
    // This Orca's own row ranks first but has no workspaces yet; it sits in another group.
    const emptyLocal: Repo = {
      ...localRepo,
      projectGroupId: localGroup.id,
      projectGroupOrder: 0
    }
    const args = {
      repoOrder: THIS_ORCA_ORDER,
      local: emptyLocal,
      groups: [pairedGroup, localGroup],
      worktrees: [pairedWorktree]
    }
    const rendered = headerKeys({
      ...args,
      placeholderRepoIds: new Set([emptyLocal.id])
    })
    const shortcutOrder = headerKeys(args)

    expect(rendered).toEqual([
      'project-group:group-a@0',
      'project-group:group-local@0',
      'project:github:stablyai/orca@1'
    ])
    expect(shortcutOrder).toEqual(rendered)
  })

  it("keeps this Orca's group when the paired host also lists a same-id copy of it", () => {
    const groupedLocal: Repo = { ...localRepo, projectGroupId: localGroup.id, projectGroupOrder: 0 }
    const pairedCopy: ProjectGroup = { ...localGroup, executionHostId: pairedHostId }

    expect(
      headerKeys({
        repoOrder: PAIRED_HOST_ORDER,
        local: groupedLocal,
        groups: [pairedGroup, localGroup, pairedCopy]
      })
    ).toEqual([
      'project-group:group-a@0',
      'project-group:group-local@0',
      'project:github:stablyai/orca@1'
    ])
  })

  it("places the project by the paired row when this Orca's row only inherited its group id", () => {
    // The window copies an earlier copy's group onto a fetched row that names none.
    const inheritedLocal: Repo = { ...localRepo, projectGroupId: pairedGroup.id }
    const rows = planRows({ repoOrder: THIS_ORCA_ORDER, local: inheritedLocal }).render(new Set())
    const header = rows.find((row) => row.type === 'header' && row.key === `project:${project.id}`)

    expect(header?.type === 'header' ? header.projectGroupRepo?.id : undefined).toBe(pairedRepo.id)
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
