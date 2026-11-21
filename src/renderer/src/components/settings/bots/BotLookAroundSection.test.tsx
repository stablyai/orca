// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'

vi.mock('@/components/bots/use-bot-activity', () => ({
  useBotActivity: () => ({
    upNext: { state: { running: false, lastLookedAt: 1, tookMs: 180_000, seenAt: 0 }, items: [] }
  })
}))
vi.mock('@/components/bots/bot-up-next-actions', () => ({ lookNow: vi.fn() }))

import { BotLookAroundSection } from './BotLookAroundSection'

const base: Bot = {
  id: 'b1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

afterEach(() => cleanup())

describe('Look around settings', () => {
  it('turns off from its title switch and hides the schedule controls', () => {
    const update = vi.fn(async () => null)
    const { rerender } = render(<BotLookAroundSection bot={base} update={update} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Look around' }))
    expect(update).toHaveBeenCalledWith({ lookAround: { on: false } })

    const off = {
      ...base,
      lookAround: { on: false, every: 'every-4h', weekdaysOnly: true, focus: '' }
    } as const
    rerender(<BotLookAroundSection bot={off} update={update} />)
    expect(screen.queryByRole('switch', { name: 'Weekdays only' })).toBeNull()
  })

  it('saves Look for when the field loses focus', () => {
    const update = vi.fn(async () => null)
    render(<BotLookAroundSection bot={base} update={update} />)
    const field = screen.getByLabelText('Look for')
    fireEvent.change(field, { target: { value: '  CI on main ' } })
    fireEvent.blur(field)
    expect(update).toHaveBeenCalledWith({
      lookAround: { focus: 'CI on main' }
    })
  })
})
