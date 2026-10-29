import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'
import { repo, worktree, repoMap, makeDetectedWorktree } from './worktree-list-groups-test-fixtures'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { NewExternalWorktreesInboxCandidate } from '../../../../shared/sidebar-list/row-types'

const repoTwo: Repo = { ...repo, id: 'repo-2', displayName: 'auth-service' }

function makeTwoRepoPinnedWorktrees(): Worktree[] {
  return [
    { ...worktree, id: 'repo-1-pinned-a', isPinned: true },
    {
      ...worktree,
      id: 'repo-2-pinned',
      repoId: repoTwo.id,
      isPinned: true,
      displayName: 'auth-main'
    },
    { ...worktree, id: 'repo-1-pinned-b', isPinned: true }
  ]
}

function makeTwoRepoInbox(): Map<string, NewExternalWorktreesInboxCandidate> {
  return new Map([
    [repo.id, { repo, inboxWorktrees: [makeDetectedWorktree({ id: 'hidden-one' })] }],
    [
      repoTwo.id,
      {
        repo: repoTwo,
        inboxWorktrees: [makeDetectedWorktree({ id: 'hidden-two', repoId: repoTwo.id })]
      }
    ]
  ])
}

describe('buildRows with hidden-worktree notices', () => {
  it('emits an empty ungrouped repo placeholder header', () => {
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
      new Set([repo.id])
    )

    expect(rows).toMatchObject([{ type: 'header', key: 'repo:repo-1', label: 'orca' }])
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

  it('does not emit unpinned new external worktrees inbox rows outside repo grouping', () => {
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
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.some((row) => row.type === 'new-external-worktrees-inbox')).toBe(false)
  })

  it.each(['none', 'pr-status', 'workspace-status'] as const)(
    'places %s-grouping notice fallbacks after each repo last pinned row when expanded',
    (groupBy) => {
      const pinned = makeTwoRepoPinnedWorktrees()
      const rows = buildRows(
        groupBy,
        pinned,
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
        new Map(pinned.map((pinnedWorktree) => [pinnedWorktree.id, pinnedWorktree])),
        false,
        undefined,
        [],
        new Set(),
        makeTwoRepoInbox()
      )

      expect(rows.map((row) => (row.type === 'item' ? row.worktree.id : row.key))).toEqual([
        PINNED_GROUP_KEY,
        'repo-1-pinned-a',
        'repo-2-pinned',
        'new-external-worktrees-inbox:repo-2',
        'repo-1-pinned-b',
        'new-external-worktrees-inbox:repo-1'
      ])
    }
  )

  it('places collapsed non-repo notice fallbacks after Pinned in pinned repo order', () => {
    const pinned = makeTwoRepoPinnedWorktrees()
    const rows = buildRows(
      'workspace-status',
      pinned,
      new Map([
        [repo.id, repo],
        [repoTwo.id, repoTwo]
      ]),
      null,
      new Set([PINNED_GROUP_KEY]),
      undefined,
      undefined,
      undefined,
      {},
      new Map(pinned.map((pinnedWorktree) => [pinnedWorktree.id, pinnedWorktree])),
      false,
      undefined,
      [],
      new Set(),
      makeTwoRepoInbox()
    )

    expect(rows).toMatchObject([
      { type: 'header', key: PINNED_GROUP_KEY, count: 3 },
      { type: 'new-external-worktrees-inbox', repo: { id: repo.id } },
      { type: 'new-external-worktrees-inbox', repo: { id: repoTwo.id } }
    ])
  })

  it('suppresses the pinned notice fallback when the repo has visible unpinned rows', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'none',
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
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.some((row) => row.type === 'new-external-worktrees-inbox')).toBe(false)
  })

  it('suppresses duplicate-mode notice fallback only when a natural anchor renders', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const inbox = new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    const buildFlatRows = (collapsedGroups: Set<string>) =>
      buildRows(
        'none',
        [pinnedWorktree],
        repoMap,
        null,
        collapsedGroups,
        undefined,
        undefined,
        undefined,
        {},
        new Map([[pinnedWorktree.id, pinnedWorktree]]),
        false,
        { showPinnedWorktreesInGroups: true } as never,
        [],
        new Set(),
        inbox
      )

    expect(
      buildFlatRows(new Set()).some((row) => row.type === 'new-external-worktrees-inbox')
    ).toBe(false)
    expect(buildFlatRows(new Set(['all']))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'new-external-worktrees-inbox',
          key: 'new-external-worktrees-inbox:repo-1'
        })
      ])
    )
  })

  it('emits the repo notice only once in repo grouping when visible rows are pinned', () => {
    const pinned = makeTwoRepoPinnedWorktrees()
    const rows = buildRows(
      'repo',
      pinned,
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
      new Map(pinned.map((pinnedWorktree) => [pinnedWorktree.id, pinnedWorktree])),
      false,
      undefined,
      [],
      new Set(),
      makeTwoRepoInbox()
    )

    expect(rows.filter((row) => row.type === 'new-external-worktrees-inbox')).toMatchObject([
      { key: 'new-external-worktrees-inbox:repo-1' },
      { key: 'new-external-worktrees-inbox:repo-2' }
    ])
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
      new Set()
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

  it('keeps the repo hidden-worktrees notice visible when Pinned is collapsed', () => {
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
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'header', key: 'repo:repo-1' },
      { type: 'new-external-worktrees-inbox', key: 'new-external-worktrees-inbox:repo-1' }
    ])
    expect(
      rows.filter((row) => row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY)
    ).toEqual([])
  })
})
