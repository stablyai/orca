import { describe, expect, it } from 'vitest'
import { laneStatusWithLineage, lineageLaneStatus } from './worktree-card-lineage-lane-status'

describe('lineageLaneStatus', () => {
  it('claims the most urgent loud state and ignores unread', () => {
    expect(lineageLaneStatus([{ kind: 'unread', at: 1, manual: false }])).toBeNull()
    expect(
      lineageLaneStatus([
        { kind: 'unread', at: 1, manual: false },
        { kind: 'working', at: 2 }
      ])
    ).toBe('working')
    expect(lineageLaneStatus([{ kind: 'working', at: 2, monitoring: true }])).toBe('monitoring')
    expect(
      lineageLaneStatus([
        { kind: 'needs', count: 1 },
        { kind: 'failed' },
        { kind: 'working', at: 2 }
      ])
    ).toBe('permission')
  })
})

describe('laneStatusWithLineage', () => {
  it('lets a running descendant replace a quiet parent', () => {
    expect(laneStatusWithLineage('inactive', 'working')).toBe('working')
    expect(laneStatusWithLineage('done', 'permission')).toBe('permission')
    expect(laneStatusWithLineage('active', null)).toBe('active')
  })

  it('keeps the parent when its own state is as urgent or more', () => {
    expect(laneStatusWithLineage('permission', 'working')).toBe('permission')
    expect(laneStatusWithLineage('working', 'monitoring')).toBe('working')
    expect(laneStatusWithLineage('failed', 'failed')).toBe('failed')
  })
})
