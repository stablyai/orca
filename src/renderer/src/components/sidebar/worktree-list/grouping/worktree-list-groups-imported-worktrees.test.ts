import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows.test-fixture'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { repo, worktree, repoMap, makeDetectedWorktree } from './worktree-list-groups-test-fixtures'
import type { Repo } from '../../../../../../shared/repo-types'

describe('buildRows with pinned worktrees', () => {
  it('emits an imported worktrees card at the top of repo-group rows', () => {
    const hidden = [
      makeDetectedWorktree({ id: 'hidden-1', displayName: 'payments-refactor' }),
      makeDetectedWorktree({ id: 'hidden-2', displayName: 'auth-cache-debug' }),
      makeDetectedWorktree({ id: 'hidden-3', displayName: 'legacy-oauth-fix' })
    ]
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: hidden }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'imported-worktrees-card',
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group',
        repo: { id: 'repo-1' },
        hiddenWorktrees: [{ id: 'hidden-1' }, { id: 'hidden-2' }, { id: 'hidden-3' }]
      },
      { type: 'item', worktree: { id: 'wt-1' } }
    ])
  })

  it('suppresses the repo-group imported worktrees card when the repo group is collapsed', () => {
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(['repo:repo-1']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([{ type: 'header', key: 'repo:repo-1' }])
  })

  it('emits a repo header and imported worktrees card when no visible worktree rows remain', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'imported-worktrees-card',
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group'
      }
    ])
  })

  it('emits an empty ungrouped repo placeholder before imported cards are merged', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      new Map([[repo.id, 0]]),
      undefined,
      'manual',
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set([repo.id]),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1', label: 'orca' },
      {
        type: 'imported-worktrees-card',
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group'
      }
    ])
  })

  it('skips stale empty placeholder repo ids that are absent from repoMap', () => {
    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set([repo.id])
    )

    expect(rows).toEqual([])
  })

  it('shows one line for every project at the end of a list not grouped by project', () => {
    const repoTwo: Repo = { ...repo, id: 'repo-2', displayName: 'auth-service' }
    const pinned = { ...worktree, id: 'repo-1-pinned', isPinned: true }
    const review = {
      ...worktree,
      id: 'repo-2-review',
      repoId: repoTwo.id,
      workspaceStatus: 'in-review' as const
    }
    const hiddenOne = makeDetectedWorktree({ id: 'hidden-one' })
    const hiddenTwo = makeDetectedWorktree({ id: 'hidden-two', repoId: repoTwo.id })
    for (const [groupBy, collapsed] of [
      ['workspace-status', new Set<string>()],
      ['workspace-status', new Set([PINNED_GROUP_KEY])],
      ['none', new Set(['all'])]
    ] as const) {
      const rows = buildRows(
        groupBy,
        [pinned, review],
        new Map([
          [repo.id, repo],
          [repoTwo.id, repoTwo]
        ]),
        null,
        new Set(collapsed),
        undefined,
        undefined,
        undefined,
        {},
        new Map([
          [pinned.id, pinned],
          [review.id, review]
        ]),
        false,
        undefined,
        [],
        new Set(),
        new Map([
          [repo.id, { repo, hiddenWorktrees: [hiddenOne] }],
          [repoTwo.id, { repo: repoTwo, hiddenWorktrees: [hiddenTwo] }]
        ])
      )

      expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toHaveLength(1)
      expect(rows.at(-1)).toMatchObject({
        type: 'imported-worktrees-card',
        placement: 'all-projects',
        projects: [{ hiddenWorktrees: [hiddenOne] }, { hiddenWorktrees: [hiddenTwo] }]
      })
      expect(rows.at(-1)).not.toHaveProperty('hostContextLabel')
    }
  })

  it('emits a new external worktrees inbox row before repo worktree rows', () => {
    const inboxWorktrees = [
      makeDetectedWorktree({ id: 'inbox-1', displayName: 'payments-refactor' }),
      makeDetectedWorktree({ id: 'inbox-2', displayName: 'auth-cache-debug' })
    ]
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'new-external-worktrees-inbox',
        key: 'new-external-worktrees-inbox:repo-1',
        repo: { id: 'repo-1' },
        inboxWorktrees: [{ id: 'inbox-1' }, { id: 'inbox-2' }]
      },
      { type: 'item', worktree: { id: 'wt-1' } }
    ])
  })

  it('suppresses the new external worktrees inbox row when the repo group is collapsed', () => {
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(['repo:repo-1']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([{ type: 'header', key: 'repo:repo-1' }])
  })

  it('emits a repo header and inbox row when no visible worktree rows remain', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'new-external-worktrees-inbox',
        key: 'new-external-worktrees-inbox:repo-1'
      }
    ])
  })

  it('keeps the inbox group when the repo only has a pinned worktree', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: pinnedWorktree.id })
        }),
        expect.objectContaining({ type: 'header', key: `repo:${repo.id}` }),
        expect.objectContaining({
          type: 'new-external-worktrees-inbox',
          key: `new-external-worktrees-inbox:${repo.id}`
        })
      ])
    )
    expect(
      rows.some(
        (row) =>
          row.type === 'item' &&
          row.sectionKey === `repo:${repo.id}` &&
          row.worktree.id === pinnedWorktree.id
      )
    ).toBe(false)
  })

  it('does not emit new external worktrees inbox rows outside repo grouping', () => {
    const rows = buildRows(
      'workspace-status',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.some((row) => row.type === 'new-external-worktrees-inbox')).toBe(false)
  })

  it('emits imported worktree cards in repo groups when visible rows are pinned', () => {
    const repoTwo: Repo = { ...repo, id: 'repo-2', displayName: 'auth-service' }
    const pinnedOneA = { ...worktree, id: 'repo-1-pinned-a', isPinned: true }
    const pinnedTwo = {
      ...worktree,
      id: 'repo-2-pinned',
      repoId: repoTwo.id,
      isPinned: true,
      displayName: 'auth-main'
    }
    const pinnedOneB = { ...worktree, id: 'repo-1-pinned-b', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedOneA, pinnedTwo, pinnedOneB],
      new Map([
        [repo.id, repo],
        [repoTwo.id, repoTwo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [pinnedOneA.id, pinnedOneA],
        [pinnedTwo.id, pinnedTwo],
        [pinnedOneB.id, pinnedOneB]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map([
        [repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree({ id: 'hidden-one' })] }],
        [
          repoTwo.id,
          {
            repo: repoTwo,
            hiddenWorktrees: [makeDetectedWorktree({ id: 'hidden-two', repoId: repoTwo.id })]
          }
        ]
      ])
    )

    expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toMatchObject([
      {
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group'
      },
      {
        key: 'imported-worktrees-card:repo-group:repo-2',
        placement: 'repo-group'
      }
    ])
    expect(
      rows.filter((row) => row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY)
    ).toEqual([])
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'repo-1-pinned-a' })
        }),
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'repo-1-pinned-b' })
        }),
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'repo-2-pinned' })
        })
      ])
    )
  })

  it('duplicates pinned worktrees into repo groups when the policy allows it', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      { showPinnedWorktreesInGroups: true } as never,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'wt-pinned' })
        }),
        expect.objectContaining({
          type: 'item',
          sectionKey: `repo:${repo.id}`,
          worktree: expect.objectContaining({ id: 'wt-pinned' })
        })
      ])
    )
  })

  it('suppresses pinned imported worktree fallback when the repo has visible unpinned rows', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree, worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [pinnedWorktree.id, pinnedWorktree],
        [worktree.id, worktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toMatchObject([
      { placement: 'repo-group' }
    ])
  })

  it('keeps repo imported worktree cards visible when Pinned is collapsed', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(['pinned']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'header', key: 'repo:repo-1' },
      { type: 'imported-worktrees-card', placement: 'repo-group' }
    ])
    expect(
      rows.filter((row) => row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY)
    ).toEqual([])
  })
})
