import { describe, expect, it } from 'vitest'
import type { GitStatusEntry, GitStatusResult } from '../../../../../shared/git-status-types'
import {
  buildRepoEntryKey,
  countChangedFiles,
  getRepoDiscardPathsByArea,
  isNestedRepoScanIncomplete,
  isRepoDiscardBlocked,
  selectChangedRepos,
  selectImmediateChildRepos,
  type FolderWorkspaceRepoStatusOutcome
} from './changed-repo-model'

function entry(overrides: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return { status: 'modified', area: 'unstaged', ...overrides }
}

function status(entries: GitStatusEntry[], branch = 'main'): GitStatusResult {
  return { entries, conflictOperation: 'unknown', branch }
}

describe('selectImmediateChildRepos', () => {
  it('keeps only depth-one repos, sorted by name', () => {
    const repos = selectImmediateChildRepos(
      {
        selectedPathKind: 'non_git_folder',
        repos: [
          { path: '/meta/zeta', displayName: 'zeta', depth: 1 },
          { path: '/meta/tools/nested', displayName: 'nested', depth: 2 },
          { path: '/meta/alpha', displayName: 'alpha', depth: 1 }
        ]
      },
      '/meta'
    )
    expect(repos).toEqual([
      { path: '/meta/alpha', name: 'alpha' },
      { path: '/meta/zeta', name: 'zeta' }
    ])
  })

  it('treats a folder that is itself a git repo as a single-repo workspace', () => {
    expect(
      selectImmediateChildRepos({ selectedPathKind: 'git_repo', repos: [] }, '/meta/app')
    ).toEqual([{ path: '/meta/app', name: 'app' }])
  })
})

describe('isNestedRepoScanIncomplete', () => {
  it('flags a scan that hit the repo cap, timed out, or was stopped', () => {
    expect(isNestedRepoScanIncomplete({ truncated: false, timedOut: false, stopped: false })).toBe(
      false
    )
    expect(isNestedRepoScanIncomplete({ truncated: true, timedOut: false, stopped: false })).toBe(
      true
    )
    expect(isNestedRepoScanIncomplete({ truncated: false, timedOut: true, stopped: false })).toBe(
      true
    )
    expect(isNestedRepoScanIncomplete({ truncated: false, timedOut: false, stopped: true })).toBe(
      true
    )
  })
})

describe('selectChangedRepos', () => {
  const candidates = [
    { path: '/meta/alpha', name: 'alpha' },
    { path: '/meta/beta', name: 'beta' },
    { path: '/meta/gamma', name: 'gamma' },
    { path: '/meta/delta', name: 'delta' }
  ]

  it('hides clean and still-loading repos and separates failures', () => {
    const outcomes = new Map<string, FolderWorkspaceRepoStatusOutcome>([
      ['/meta/alpha', { kind: 'ready', status: status([]) }],
      [
        '/meta/beta',
        {
          kind: 'ready',
          status: status([entry({ path: 'src/a.ts' })], 'feat')
        }
      ],
      ['/meta/gamma', { kind: 'loading' }],
      ['/meta/delta', { kind: 'error', error: new Error('boom') }]
    ])
    const { changed, failed } = selectChangedRepos(candidates, outcomes)
    expect(changed).toEqual([
      {
        path: '/meta/beta',
        name: 'beta',
        branch: 'feat',
        entries: [entry({ path: 'src/a.ts' })],
        didHitLimit: false
      }
    ])
    expect(failed.map((repo) => repo.name)).toEqual(['delta'])
  })

  it('carries the status cap so a partial entry list is never mistaken for the full change set', () => {
    const outcomes = new Map<string, FolderWorkspaceRepoStatusOutcome>([
      [
        '/meta/alpha',
        {
          kind: 'ready',
          status: { ...status([entry({ path: 'a' })]), didHitLimit: true, statusLength: 1_200 }
        }
      ]
    ])
    const { changed } = selectChangedRepos(candidates, outcomes)
    expect(changed.map((repo) => repo.didHitLimit)).toEqual([true])
    expect(isRepoDiscardBlocked(changed[0])).toBe(true)
  })

  it('counts files across every changed repo', () => {
    const outcomes = new Map<string, FolderWorkspaceRepoStatusOutcome>([
      [
        '/meta/alpha',
        {
          kind: 'ready',
          status: status([entry({ path: 'a' }), entry({ path: 'b' })])
        }
      ],
      ['/meta/beta', { kind: 'ready', status: status([entry({ path: 'c' })]) }]
    ])
    expect(countChangedFiles(selectChangedRepos(candidates, outcomes).changed)).toBe(3)
  })
})

describe('getRepoDiscardPathsByArea', () => {
  it('orders staged before unstaged and untracked and skips conflict rows', () => {
    const entries = [
      entry({ path: 'untracked.txt', area: 'untracked', status: 'untracked' }),
      entry({ path: 'staged.ts', area: 'staged', status: 'added' }),
      entry({ path: 'changed.ts' }),
      entry({ path: 'conflict.ts', conflictStatus: 'unresolved' })
    ]
    expect(getRepoDiscardPathsByArea(entries)).toEqual([
      { area: 'staged', paths: ['staged.ts'] },
      { area: 'unstaged', paths: ['changed.ts'] },
      { area: 'untracked', paths: ['untracked.txt'] }
    ])
  })
})

describe('buildRepoEntryKey', () => {
  it('scopes the key by repo and staging area so the same path in two repos stays distinct', () => {
    const changed = entry({ path: 'src/a.ts' })
    expect(buildRepoEntryKey('/meta/alpha', changed)).not.toBe(
      buildRepoEntryKey('/meta/beta', changed)
    )
    expect(buildRepoEntryKey('/meta/alpha', changed)).not.toBe(
      buildRepoEntryKey('/meta/alpha', entry({ path: 'src/a.ts', area: 'staged' }))
    )
  })
})
