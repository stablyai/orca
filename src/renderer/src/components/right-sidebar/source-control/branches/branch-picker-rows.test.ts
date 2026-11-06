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
    { kind: 'local', name: 'feat-existing' },
    { kind: 'remote', name: 'origin/feat' }
  ])
  expect(
    branchPickerRows(localRows, names, null, 'feat-existing').some(
      (row) => row.target.kind === 'new'
    )
  ).toBe(false)
  expect(branchPickerRows(localRows, names, null, 'bad..name')).toEqual([])
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
