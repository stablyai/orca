import { describe, expect, it } from 'vitest'

import {
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef
} from '../../../../../../shared/source-control/decisions/source-control-base-ref-resolution'

describe('SourceControl compare summary', () => {
  it('repairs stale PR head SHA compare bases from linked review metadata', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'main',
        repoBaseRef: null,
        defaultBaseRef: 'origin/main'
      })
    ).toBe('origin/main')
  })

  it('does not treat nested branch suffix matches as the review target', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'main',
        repoBaseRef: null,
        defaultBaseRef: 'origin/release/main'
      })
    ).toBe('origin/main')

    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'main',
        repoBaseRef: null,
        defaultBaseRef: 'refs/remotes/upstream/release/main'
      })
    ).toBe('refs/remotes/upstream/main')
  })

  it('prefers a remote-tracking repo base over a stale local worktree default', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: 'master',
        repoBaseRef: 'origin/master',
        defaultBaseRef: 'origin/master'
      })
    ).toBe('origin/master')

    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: 'refs/heads/master',
        repoBaseRef: null,
        defaultBaseRef: 'origin/master'
      })
    ).toBe('origin/master')
  })

  it('keeps exact slash-containing target branch matches', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'release/main',
        repoBaseRef: null,
        defaultBaseRef: 'origin/release/main'
      })
    ).toBe('origin/release/main')
  })

  it('prefers a remote-tracking repo pin over a stale local worktree default when on', () => {
    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: 'master',
        repoBaseRef: 'origin/master',
        upstreamName: 'origin/feature',
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('origin/master')
  })

  it('prefers a pinned base over the upstream when the setting is on', () => {
    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: 'refs/remotes/origin/release',
        repoBaseRef: 'origin/main',
        upstreamName: 'origin/feature',
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('refs/remotes/origin/release')

    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: null,
        repoBaseRef: ' origin/main ',
        upstreamName: 'origin/feature',
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('origin/main')
  })
})
