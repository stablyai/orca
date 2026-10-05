import { describe, expect, it } from 'vitest'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { matchesPaletteSessionStatus } from './palette-session-status-filter'

const statuses: readonly (WorktreeStatus | null)[] = [
  'permission',
  'working',
  'monitoring',
  'done',
  'active',
  'inactive',
  'failed',
  'interrupted',
  'unconfirmed',
  null
]

describe('matchesPaletteSessionStatus', () => {
  it('unions waiting and finished without admitting working or quiet sessions', () => {
    expect(
      statuses.filter((status) =>
        matchesPaletteSessionStatus(['waiting', 'finished'], status, false)
      )
    ).toEqual(['permission', 'done'])
  })

  it.each(['permission', 'working', 'monitoring'] as const)(
    'keeps unread %s sessions in their active category rather than Finished',
    (status) => {
      expect(matchesPaletteSessionStatus(['finished'], status, true)).toBe(false)
      expect(
        matchesPaletteSessionStatus([status === 'permission' ? 'waiting' : 'working'], status, true)
      ).toBe(true)
    }
  )

  it.each(['active', 'inactive'] as const)(
    'includes an old %s session with unread output in Finished, not Idle',
    (status) => {
      expect(matchesPaletteSessionStatus(['finished'], status, true)).toBe(true)
      expect(matchesPaletteSessionStatus(['idle'], status, true)).toBe(false)
      expect(matchesPaletteSessionStatus(['finished'], status, false)).toBe(false)
      expect(matchesPaletteSessionStatus(['idle'], status, false)).toBe(true)
    }
  )

  it.each(['failed', 'interrupted', 'unconfirmed'] as const)(
    'does not mislabel a %s outcome without unread output as Finished or Idle',
    (status) => {
      expect(matchesPaletteSessionStatus(['finished', 'idle'], status, false)).toBe(false)
    }
  )

  it('excludes non-session rows even when every category is selected', () => {
    expect(
      matchesPaletteSessionStatus(['waiting', 'finished', 'working', 'idle'], null, true)
    ).toBe(false)
  })

  it('removes every status restriction when cleared, including non-session and failed rows', () => {
    expect(statuses.filter((status) => matchesPaletteSessionStatus([], status, false))).toEqual(
      statuses
    )
    expect(statuses.filter((status) => matchesPaletteSessionStatus([], status, true))).toEqual(
      statuses
    )
  })
})
