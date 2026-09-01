import { describe, expect, it } from 'vitest'
import { createDefaultWorkspaceCleanupBrowseState } from './workspace-cleanup-browse-state'
import { mergeWorkspaceCleanupUIState } from './workspace-cleanup-ui-state'

describe('workspace cleanup UI state', () => {
  it('keeps browse state when a legacy peer publishes dismissals only', () => {
    const browse = createDefaultWorkspaceCleanupBrowseState()
    browse.filters.query = 'stale'

    expect(
      mergeWorkspaceCleanupUIState(
        { dismissals: {}, browse },
        {
          dismissals: {
            'wt-1': {
              worktreeId: 'wt-1',
              dismissedAt: 1700000000000,
              fingerprint: 'fp-1',
              classifierVersion: 2
            }
          }
        }
      )
    ).toEqual({
      dismissals: {
        'wt-1': {
          worktreeId: 'wt-1',
          dismissedAt: 1700000000000,
          fingerprint: 'fp-1',
          classifierVersion: 2
        }
      },
      browse
    })
  })

  it('keeps dismissals when the browse writer publishes a browse-only patch', () => {
    const browse = createDefaultWorkspaceCleanupBrowseState()
    browse.filters.query = 'fresh'

    expect(
      mergeWorkspaceCleanupUIState(
        {
          dismissals: {
            'wt-1': {
              worktreeId: 'wt-1',
              dismissedAt: 1700000000000,
              fingerprint: 'fp-1',
              classifierVersion: 2
            }
          }
        },
        { browse }
      )
    ).toEqual({
      dismissals: {
        'wt-1': {
          worktreeId: 'wt-1',
          dismissedAt: 1700000000000,
          fingerprint: 'fp-1',
          classifierVersion: 2
        }
      },
      browse
    })
  })

  it('accepts browse state published by a compatible peer', () => {
    const current = createDefaultWorkspaceCleanupBrowseState()
    current.filters.query = 'local'
    const incoming = createDefaultWorkspaceCleanupBrowseState()
    incoming.filters.query = 'host'

    expect(
      mergeWorkspaceCleanupUIState(
        { dismissals: {}, browse: current },
        { dismissals: {}, browse: incoming }
      )?.browse
    ).toBe(incoming)
  })
})
