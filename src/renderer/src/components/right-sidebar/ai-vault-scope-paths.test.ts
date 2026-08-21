import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from './ai-vault-scope-paths'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/orca',
    repoId: 'repo-1',
    displayName: 'orca',
    path: '/repo/orca',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    isMainWorktree: false,
    ...overrides
  }
}

describe('deriveAiVaultWorkspaceScopePaths', () => {
  it('returns the active workspace path', () => {
    const active = makeWorktree()
    expect(deriveAiVaultWorkspaceScopePaths(active, [active])).toEqual(['/repo/orca'])
  })

  it('returns nothing without an active workspace', () => {
    expect(deriveAiVaultWorkspaceScopePaths(null, [makeWorktree()])).toEqual([])
  })

  it('includes prior paths so renamed workspaces keep their transcripts', () => {
    const active = makeWorktree({
      id: 'repo-1::/repo/orca-renamed',
      path: '/repo/orca-renamed',
      priorWorktreeIds: ['repo-1::/repo/orca']
    })

    expect(deriveAiVaultWorkspaceScopePaths(active, [active])).toEqual([
      '/repo/orca-renamed',
      '/repo/orca'
    ])
  })

  it('drops a prior path another live workspace now owns', () => {
    // Sessions are keyed by cwd alone, so claiming a path a live workspace
    // occupies would show that workspace's transcripts under this one.
    const claimant = makeWorktree({ id: 'repo-1::/repo/orca', path: '/repo/orca' })
    const active = makeWorktree({
      id: 'repo-1::/repo/orca-renamed',
      path: '/repo/orca-renamed',
      priorWorktreeIds: ['repo-1::/repo/orca']
    })

    expect(deriveAiVaultWorkspaceScopePaths(active, [claimant, active])).toEqual([
      '/repo/orca-renamed'
    ])
  })

  it('keeps a prior path the active workspace itself still owns', () => {
    const active = makeWorktree({ priorWorktreeIds: ['repo-1::/repo/orca'] })
    expect(deriveAiVaultWorkspaceScopePaths(active, [active])).toEqual(['/repo/orca'])
  })

  it('drops a claimed prior path regardless of where the claimant sits in the list', () => {
    // Ordering must not decide the claim: a lookup keyed by path has to
    // exclude the active workspace up front, or listing it before a claimant
    // that shares the path would mask the claim.
    const active = makeWorktree({
      id: 'repo-1::/repo/orca-renamed',
      path: '/repo/orca-renamed',
      priorWorktreeIds: ['repo-1::/repo/orca']
    })
    const claimant = makeWorktree({ id: 'repo-1::/repo/orca', path: '/repo/orca' })
    // The active workspace also listed at the prior path — the only shape where
    // a first-writer-wins map would name the active workspace the owner and so
    // report the path unclaimed.
    const activeAtPriorPath = makeWorktree({ id: active.id, path: '/repo/orca' })

    for (const liveWorktrees of [
      [active, claimant],
      [claimant, active],
      [activeAtPriorPath, claimant],
      [claimant, activeAtPriorPath]
    ]) {
      expect(deriveAiVaultWorkspaceScopePaths(active, liveWorktrees)).toEqual([
        '/repo/orca-renamed'
      ])
    }
  })

  it('derives workspace scope paths at scale', () => {
    // Separate from the session-scope guard: a quadratic dedupe reintroduced
    // only in the workspace pass would not surface there.
    const prefix = '/Users/dev/orca/workspaces/orca-monorepo/feature-'
    const worktrees = Array.from({ length: 1200 }, (_, i) =>
      makeWorktree({ id: `repo-1::${prefix}${i}`, path: `${prefix}${i}` })
    )
    const active = makeWorktree({
      id: `repo-1::${prefix}0`,
      path: `${prefix}0`,
      // Priors drive the claim check, which is the other per-call scan here.
      priorWorktreeIds: Array.from({ length: 25 }, (_, i) => `repo-1::${prefix}prior-${i}`)
    })

    const startedAt = performance.now()
    const paths = deriveAiVaultWorkspaceScopePaths(active, worktrees)
    const elapsedMs = performance.now() - startedAt

    expect(paths).toHaveLength(1 + 25)
    expect(elapsedMs).toBeLessThan(100)
  })

  it('ignores prior ids belonging to another repo', () => {
    const active = makeWorktree({ priorWorktreeIds: ['repo-2::/repo/other'] })
    expect(deriveAiVaultWorkspaceScopePaths(active, [active])).toEqual(['/repo/orca'])
  })

  it('skips relative and blank paths', () => {
    const active = makeWorktree({ path: 'relative/path' })
    expect(deriveAiVaultWorkspaceScopePaths(active, [active])).toEqual([])
    expect(deriveAiVaultWorkspaceScopePaths(makeWorktree({ path: '   ' }), [])).toEqual([])
  })
})

describe('deriveAiVaultScopeSessionPaths', () => {
  it('covers the active workspace plus the rest of its repo', () => {
    const active = makeWorktree()
    const sibling = makeWorktree({ id: 'repo-1::/repo/feature', path: '/repo/feature' })
    const otherRepo = makeWorktree({
      id: 'repo-2::/repo/other',
      repoId: 'repo-2',
      path: '/repo/other'
    })

    expect(deriveAiVaultScopeSessionPaths(active, [active, sibling, otherRepo])).toEqual([
      '/repo/orca',
      '/repo/feature'
    ])
  })

  it('deduplicates paths that differ only by separators or trailing slash', () => {
    // The dedupe compares normalized keys; the first spelling is what ships.
    const active = makeWorktree()
    const trailing = makeWorktree({ id: 'repo-1::a', path: '/repo/orca/' })
    const doubled = makeWorktree({ id: 'repo-1::b', path: '/repo//orca' })

    expect(deriveAiVaultScopeSessionPaths(active, [active, trailing, doubled])).toEqual([
      '/repo/orca'
    ])
  })

  it('treats NFD and NFC spellings of one path as the same scope entry', () => {
    // macOS yields NFD on disk while agents record NFC cwds (#10832).
    const nfc = '/repo/프로젝트'
    const active = makeWorktree({ id: `repo-1::${nfc}`, path: nfc })
    const nfd = makeWorktree({ id: 'repo-1::nfd', path: nfc.normalize('NFD') })

    expect(deriveAiVaultScopeSessionPaths(active, [active, nfd])).toEqual([nfc])
  })

  it('derives scope paths at scale without re-normalizing the accumulator', () => {
    // Regression guard: deduping by rescanning the accumulated paths made this
    // O(n^2) in normalize('NFC') and cost ~190ms on a 1124-workspace profile —
    // on the workspace-switch path, since these paths follow the active
    // worktree. Times the real fan-out so it fails on a return to that shape.
    // Path length matters as much as count: normalize() cost scales with it,
    // so short synthetic paths would understate the old shape. ~50 chars
    // matches the real profile this was measured on.
    const prefix = '/Users/dev/orca/workspaces/orca-monorepo/feature-'
    const worktrees = Array.from({ length: 1200 }, (_, i) =>
      makeWorktree({ id: `repo-1::${prefix}${i}`, path: `${prefix}${i}` })
    )

    const startedAt = performance.now()
    const paths = deriveAiVaultScopeSessionPaths(worktrees[0], worktrees)
    const elapsedMs = performance.now() - startedAt

    expect(paths).toHaveLength(worktrees.length)
    // ~190ms before, ~1ms after; loose enough for a slow CI box.
    expect(elapsedMs).toBeLessThan(100)
  })
})
