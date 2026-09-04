import { describe, expect, it } from 'vitest'
import {
  SESSION_GRID_PRESETS,
  SESSION_GRID_STATE_FILTERS,
  normalizeSessionGridPreset,
  normalizeSessionGridScrollMode,
  normalizeSessionGridStateFilter,
  sessionGridDotStateBucket,
  type SessionGridDotState,
  type SessionGridStateFilter
} from './session-grid-types'

describe('session grid normalizers', () => {
  it('round-trips every preset the layout switch handles', () => {
    for (const preset of SESSION_GRID_PRESETS) {
      expect(normalizeSessionGridPreset(preset)).toBe(preset)
    }
  })

  it('rejects anything the layout switch has no case for', () => {
    // A hand-edited profile, a downgrade, or a newer paired client.
    for (const value of ['4x4', '', null, 42, undefined, {}]) {
      expect(normalizeSessionGridPreset(value)).toBeUndefined()
    }
  })

  it('validates the scroll mode the same way', () => {
    expect(normalizeSessionGridScrollMode('page')).toBe('page')
    expect(normalizeSessionGridScrollMode('smooth')).toBeUndefined()
  })
})

// Why a Record and not a list of pairs: `satisfies` makes a new SessionGridDotState
// fail to compile here until someone decides its bucket, which is the whole point of
// pinning a policy that lives in shared/ with no call site of its own yet.
const EXPECTED_BUCKETS = {
  working: 'working',
  monitoring: 'working',
  permission: 'attention',
  // The user's own Ctrl+C on a finished turn, not something asking for them.
  interrupted: 'done',
  done: 'done',
  idle: 'idle'
} satisfies Record<SessionGridDotState, Exclude<SessionGridStateFilter, 'all'>>

describe('sessionGridDotStateBucket', () => {
  it('buckets every dot state the grid can paint', () => {
    for (const [dotState, bucket] of Object.entries(EXPECTED_BUCKETS)) {
      expect(sessionGridDotStateBucket(dotState as SessionGridDotState)).toBe(bucket)
    }
  })

  it('sends only permission to attention, matching the dashboard bucket', () => {
    const attention = Object.keys(EXPECTED_BUCKETS).filter(
      (dotState) => sessionGridDotStateBucket(dotState as SessionGridDotState) === 'attention'
    )
    expect(attention).toEqual(['permission'])
  })
})

describe('normalizeSessionGridStateFilter', () => {
  it('round-trips every bucket the filter offers', () => {
    for (const filter of SESSION_GRID_STATE_FILTERS) {
      expect(normalizeSessionGridStateFilter(filter)).toBe(filter)
    }
  })

  it('rejects a bucket this build has no case for', () => {
    // 'blocked' and 'waiting' are the dashboard's dot states, never grid buckets.
    for (const value of ['blocked', 'waiting', 'interrupted', '', null, 3, undefined]) {
      expect(normalizeSessionGridStateFilter(value)).toBeUndefined()
    }
  })
})
