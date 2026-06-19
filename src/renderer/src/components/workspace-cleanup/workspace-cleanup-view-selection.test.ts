import { describe, expect, it } from 'vitest'
import {
  resolveWorkspaceCleanupActiveView,
  type WorkspaceCleanupViewCounts
} from './workspace-cleanup-view-selection'

const emptyCounts: WorkspaceCleanupViewCounts = {
  ready: 0,
  review: 0,
  protected: 0,
  hidden: 0
}

describe('resolveWorkspaceCleanupActiveView', () => {
  it('keeps the requested view while it still has rows', () => {
    expect(
      resolveWorkspaceCleanupActiveView({
        requestedView: 'review',
        counts: { ...emptyCounts, ready: 2, review: 1 },
        open: true,
        loading: false,
        hasScan: true
      })
    ).toBe('review')
  })

  it('falls back to the first populated cleanup view when the requested view is empty', () => {
    expect(
      resolveWorkspaceCleanupActiveView({
        requestedView: 'protected',
        counts: { ...emptyCounts, review: 3, hidden: 1 },
        open: true,
        loading: false,
        hasScan: true
      })
    ).toBe('review')
  })

  it('uses hidden suggestions when no visible cleanup views have rows', () => {
    expect(
      resolveWorkspaceCleanupActiveView({
        requestedView: 'ready',
        counts: { ...emptyCounts, hidden: 2 },
        open: true,
        loading: false,
        hasScan: true
      })
    ).toBe('hidden')
  })

  it('leaves the requested view alone before an open completed scan', () => {
    expect(
      resolveWorkspaceCleanupActiveView({
        requestedView: 'protected',
        counts: { ...emptyCounts, ready: 4 },
        open: false,
        loading: false,
        hasScan: true
      })
    ).toBe('protected')

    expect(
      resolveWorkspaceCleanupActiveView({
        requestedView: 'protected',
        counts: { ...emptyCounts, ready: 4 },
        open: true,
        loading: true,
        hasScan: true
      })
    ).toBe('protected')

    expect(
      resolveWorkspaceCleanupActiveView({
        requestedView: 'protected',
        counts: { ...emptyCounts, ready: 4 },
        open: true,
        loading: false,
        hasScan: false
      })
    ).toBe('protected')
  })

  it('keeps an empty requested view when every view is empty', () => {
    expect(
      resolveWorkspaceCleanupActiveView({
        requestedView: 'hidden',
        counts: emptyCounts,
        open: true,
        loading: false,
        hasScan: true
      })
    ).toBe('hidden')
  })
})
