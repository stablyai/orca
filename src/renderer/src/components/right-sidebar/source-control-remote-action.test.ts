import { describe, expect, it } from 'vitest'
import {
  resolveRemoteActionState,
  resolveRemoteHeaderActionViewModel,
  resolveRemoteStatusCounts
} from './SourceControl'

describe('resolveRemoteActionState', () => {
  it('returns publish action when branch has no upstream', () => {
    const result = resolveRemoteActionState({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })

    expect(result).toEqual({
      kind: 'publish',
      label: 'Publish Branch',
      disabled: false
    })
  })

  it('returns push action for ahead-only branches', () => {
    const result = resolveRemoteActionState({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 0
    })

    expect(result).toEqual({
      kind: 'push',
      label: 'Push',
      disabled: false
    })
  })

  it('returns pull action for behind-only branches', () => {
    const result = resolveRemoteActionState({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 0,
      behind: 3
    })

    expect(result).toEqual({
      kind: 'pull',
      label: 'Pull',
      disabled: false
    })
  })

  it('disables pull when uncommitted changes exist', () => {
    const result = resolveRemoteActionState(
      {
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 0,
        behind: 3
      },
      { hasUncommittedChanges: true, hasConflictOperation: false, isRemoteOperationActive: false }
    )

    expect(result).toEqual({
      kind: 'pull',
      label: 'Pull',
      disabled: true
    })
  })

  it('disables all actions while a remote operation is active', () => {
    const result = resolveRemoteActionState(
      {
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 1,
        behind: 1
      },
      { hasUncommittedChanges: false, hasConflictOperation: false, isRemoteOperationActive: true }
    )

    expect(result).toEqual({
      kind: 'sync',
      label: 'Sync Changes',
      disabled: true
    })
  })

  it('shows sync changes label for diverged branch when idle', () => {
    const result = resolveRemoteActionState(
      {
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 2,
        behind: 1
      },
      { hasUncommittedChanges: false, hasConflictOperation: false, isRemoteOperationActive: false }
    )

    expect(result).toEqual({
      kind: 'sync',
      label: 'Sync Changes',
      disabled: false
    })
  })
})

describe('resolveRemoteStatusCounts', () => {
  it('returns no counters when there is no upstream', () => {
    expect(resolveRemoteStatusCounts({ hasUpstream: false, ahead: 0, behind: 0 })).toEqual({
      incoming: 0,
      outgoing: 0
    })
  })

  it('returns incoming and outgoing commit counts for tracked branches', () => {
    expect(
      resolveRemoteStatusCounts({
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 4,
        behind: 2
      })
    ).toEqual({
      incoming: 2,
      outgoing: 4
    })
  })
})

describe('resolveRemoteHeaderActionViewModel', () => {
  it('keeps divergence counters hidden when branch has no upstream', () => {
    expect(resolveRemoteHeaderActionViewModel({ hasUpstream: false, ahead: 0, behind: 0 })).toEqual(
      {
        action: {
          kind: 'publish',
          label: 'Publish Branch',
          disabled: false
        },
        counts: {
          incoming: 0,
          outgoing: 0
        },
        showDivergence: false
      }
    )
  })

  it('shows divergence counters for tracked branches with incoming/outgoing commits', () => {
    expect(
      resolveRemoteHeaderActionViewModel(
        {
          hasUpstream: true,
          upstreamName: 'origin/main',
          ahead: 2,
          behind: 1
        },
        {
          hasUncommittedChanges: false,
          hasConflictOperation: false,
          isRemoteOperationActive: false
        }
      )
    ).toEqual({
      action: {
        kind: 'sync',
        label: 'Sync Changes',
        disabled: false
      },
      counts: {
        incoming: 1,
        outgoing: 2
      },
      showDivergence: true
    })
  })
})
