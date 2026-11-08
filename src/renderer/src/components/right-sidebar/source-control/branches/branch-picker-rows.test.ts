import { expect, it } from 'vitest'
import { branchPickerRows, indexBranchWorkspaces, indexLocalBranchRows } from './branch-picker-rows'

it('uses Git occupancy, then maps navigation by host, repo and path', () => {
  const workspaces = [
    { id: 'current', repoId: 'repo', path: '/repo' },
    { id: 'other', repoId: 'repo', path: '/other' },
    { id: 'stale', repoId: 'repo', path: '/stale' },
    { id: 'twin', repoId: 'different-repo', path: '/other' }
  ]
  const index = indexBranchWorkspaces(true, workspaces, 'repo', 'local')
  const rows = indexLocalBranchRows(
    {
      current: 'main',
      branches: ['main', 'held', 'external', 'released'],
      worktreePaths: { main: '/repo', held: '/other', external: '/external' }
    },
    '/repo',
    index
  )
  expect(rows.map((row) => [row.label, row.occupiedPath, row.workspace?.id])).toEqual([
    ['main', undefined, undefined],
    ['held', '/other', 'other'],
    ['external', '/external', undefined],
    ['released', undefined, undefined]
  ])
})
it('offers valid creation with failed, pending, old-host or capped discovery; only exact known matches suppress it', () => {
  const localRows = indexLocalBranchRows(
    { current: 'main', branches: ['main', 'feat-existing'] },
    '/repo',
    null
  )
  const names = new Set(['main', 'feat-existing'])
  for (const page of [
    null,
    { refs: [], truncated: false },
    {
      refs: ['origin/feat-other'],
      refDetails: [{ refName: 'origin/feat-other', localBranchName: 'feat-other' }],
      truncated: true
    }
  ]) {
    expect(
      branchPickerRows(localRows, names, page, 'feat').map((row) => row.target)
    ).toContainEqual({ kind: 'new', name: 'feat' })
  }
  const exact = {
    refs: ['origin/feat'],
    refDetails: [{ refName: 'origin/feat', localBranchName: 'feat' }],
    truncated: true
  }
  expect(branchPickerRows(localRows, names, exact, 'feat').map((row) => row.target)).toEqual([
    { kind: 'local', name: 'main' },
    { kind: 'local', name: 'feat-existing' },
    { kind: 'remote', name: 'origin/feat' }
  ])
  expect(
    branchPickerRows(localRows, names, null, 'feat-existing').some(
      (row) => row.target.kind === 'new'
    )
  ).toBe(false)
  expect(branchPickerRows(localRows, names, null, 'bad..name').map((row) => row.label)).toEqual([
    'main'
  ])
})
it('drops tracking duplicates without confusing qualified remote refs and slash-named locals', () => {
  const page = {
    refs: [],
    truncated: false,
    refDetails: [
      { refName: 'origin/main', localBranchName: 'main' },
      { refName: 'refs/remotes/origin/topic', localBranchName: 'topic' },
      { refName: 'team/upstream/feature', localBranchName: 'feature' }
    ]
  }
  expect(
    branchPickerRows([], new Set(['main', 'origin/topic']), page, '').map((row) => row.target)
  ).toEqual([
    { kind: 'remote', name: 'origin/topic' },
    { kind: 'remote', name: 'team/upstream/feature' }
  ])
})

it('keeps an older exact local match reachable ahead of newer prefix and substring matches', () => {
  const newer = Array.from({ length: 60 }, (_, n) => `feature-${n}`)
  const branches = ['main', 'feature', 'other-feature', ...newer]
  const local = indexLocalBranchRows(
    {
      current: 'main',
      branches,
      committedAt: {
        feature: 1,
        'other-feature': 1000,
        ...Object.fromEntries(newer.map((name, n) => [name, n + 10]))
      }
    },
    '/repo',
    null
  )
  const rows = branchPickerRows(local, new Set(branches), null, 'feature')
  expect(rows).toHaveLength(50)
  expect(rows.slice(0, 4).map((row) => row.label)).toEqual([
    'main',
    'feature',
    'feature-59',
    'feature-58'
  ])
  expect(rows.some((row) => row.label === 'other-feature')).toBe(false)
})

it('shows an exact remote at the end of a full local and remote window instead of hiding both actions', () => {
  const branches = Array.from({ length: 50 }, (_, n) => `feat-${n}`)
  const local = indexLocalBranchRows({ current: null, branches }, '/repo', null)
  const refDetails = Array.from({ length: 50 }, (_, n) => ({
    refName: `origin/${n === 49 ? 'feat' : `remote-feat-${n}`}`,
    localBranchName: n === 49 ? 'feat' : `remote-feat-${n}`
  }))
  const rows = branchPickerRows(
    local,
    new Set(branches),
    { refs: [], refDetails, truncated: false },
    'feat'
  )
  expect(rows).toHaveLength(100)
  expect(rows.at(-1)?.target).toEqual({ kind: 'remote', name: 'origin/feat' })
  expect(rows.some((row) => row.target.kind === 'new')).toBe(false)
})
