// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'

vi.mock('@/components/bots/use-bot-tidy-up', () => ({
  useBotTidyUp: () => ({ view: null, tidyNow: vi.fn(), undo: vi.fn() })
}))

import { BotTidyUpSection } from './BotTidyUpSection'

const bot: Bot = {
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

describe('Memory upkeep settings', () => {
  it('turns off memory upkeep from its switch', () => {
    const update = vi.fn(async () => null)
    render(<BotTidyUpSection bot={bot} update={update} />)
    const toggle = screen.getByRole('switch', { name: 'Memory upkeep' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ tidyUp: { on: false } })
  })
})
