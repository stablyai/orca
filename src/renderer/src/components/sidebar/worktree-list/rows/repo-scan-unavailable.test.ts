// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  canOpenScanFixTerminal,
  retryUnavailableRepoScans,
  selectHostWideScanRetryTargets,
  selectUnavailableRepoScanTargets,
  type UnavailableRepoScanTarget
} from './repo-scan-unavailable'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import type { Repo } from '../../../../../../shared/repo-types'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('selectUnavailableRepoScanTargets', () => {
  it('keeps only non-authoritative listings that carry a reason', () => {
    const local = makeRepo({ id: 'local', connectionId: null })
    const ssh = makeRepo({ id: 'ssh', connectionId: 'target-1' })
    const ok = makeRepo({ id: 'ok' })
    const targets = selectUnavailableRepoScanTargets({
      repos: [local, ssh, ok],
      detectedByRepo: {
        local: makeDetectedResult('local', [], {
          authoritative: false,
          source: 'metadata-fallback',
          unavailableReason: 'xcodebuild license'
        }),
        ssh: makeDetectedResult('ssh', [], {
          authoritative: false,
          source: 'metadata-fallback',
          unavailableReason: 'ssh failure'
        }),
        ok: makeDetectedResult('ok', [])
      }
    })
    expect(targets).toEqual([
      { repoId: 'local', executionHostId: 'local', failureKind: 'xcode-license' },
      { repoId: 'ssh', executionHostId: 'ssh:target-1', failureKind: 'unknown' }
    ])
  })
})

describe('retryUnavailableRepoScans', () => {
  it('fans out once per repo id with its own execution host', async () => {
    const fetchWorktrees = vi.fn(async () => true)
    const results = await retryUnavailableRepoScans(
      [
        { repoId: 'a', executionHostId: 'local', failureKind: 'xcode-license' },
        { repoId: 'b', executionHostId: 'ssh:target-1', failureKind: 'xcode-license' }
      ],
      fetchWorktrees
    )
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktrees).toHaveBeenCalledWith('a', {
      executionHostId: 'local',
      requireAuthoritative: true
    })
    expect(fetchWorktrees).toHaveBeenCalledWith('b', {
      executionHostId: 'ssh:target-1',
      requireAuthoritative: true
    })
    expect(results).toHaveLength(2)
  })

  it('settles every target even when one retry rejects', async () => {
    const fetchWorktrees = vi
      .fn<(repoId: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(true)
    const results = await retryUnavailableRepoScans(
      [
        { repoId: 'a', executionHostId: 'local', failureKind: 'xcode-license' },
        { repoId: 'b', executionHostId: 'local', failureKind: 'xcode-license' }
      ],
      fetchWorktrees
    )
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
  })
})

describe('selectHostWideScanRetryTargets', () => {
  const targets: UnavailableRepoScanTarget[] = [
    { repoId: 'a', executionHostId: 'local', failureKind: 'xcode-license' },
    { repoId: 'b', executionHostId: 'local', failureKind: 'xcode-license' },
    { repoId: 'c', executionHostId: 'local', failureKind: 'xcode-tools-missing' },
    { repoId: 'd', executionHostId: 'ssh:box', failureKind: 'xcode-license' },
    { repoId: 'e', executionHostId: 'local', failureKind: 'unknown' }
  ]

  it('keeps same-host peers that failed the same way, minus the repo just scanned', () => {
    expect(
      selectHostWideScanRetryTargets({
        targets,
        resolvedRepoId: 'a',
        executionHostId: 'local',
        failureKind: 'xcode-license'
      }).map((target) => target.repoId)
    ).toEqual(['b'])
  })

  // Why: an unclassified failure can be repo-local, so one repo scanning clean proves nothing for peers.
  it('never fans out an unclassified failure', () => {
    expect(
      selectHostWideScanRetryTargets({
        targets,
        resolvedRepoId: 'e',
        executionHostId: 'local',
        failureKind: 'unknown'
      })
    ).toEqual([])
  })

  it('leaves other hosts alone, since a macOS fix never repaired them', () => {
    expect(
      selectHostWideScanRetryTargets({
        targets,
        resolvedRepoId: 'd',
        executionHostId: 'ssh:box',
        failureKind: 'xcode-license'
      })
    ).toEqual([])
  })
})

describe('canOpenScanFixTerminal', () => {
  it('allows a local repo on a Mac', () => {
    expect(canOpenScanFixTerminal(makeRepo({ connectionId: null, path: '/repo' }), 'darwin')).toBe(
      true
    )
  })

  // Why: the command is macOS-only, so a local Windows/Linux renderer must never be told to run it.
  it('blocks a non-darwin renderer', () => {
    expect(canOpenScanFixTerminal(makeRepo({ connectionId: null, path: '/repo' }), 'linux')).toBe(
      false
    )
    expect(
      canOpenScanFixTerminal(makeRepo({ connectionId: null, path: 'C:\\repo' }), 'win32')
    ).toBe(false)
  })

  it('blocks remote, runtime and WSL owners', () => {
    expect(canOpenScanFixTerminal(makeRepo({ connectionId: 'target-1' }), 'darwin')).toBe(false)
    expect(
      canOpenScanFixTerminal(
        makeRepo({ executionHostId: 'runtime:env-1', connectionId: null }),
        'darwin'
      )
    ).toBe(false)
    expect(
      canOpenScanFixTerminal(
        makeRepo({ connectionId: null, path: '\\\\wsl$\\kali\\repo' }),
        'darwin'
      )
    ).toBe(false)
  })
})
