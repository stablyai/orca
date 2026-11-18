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
  it('says its schedule beside the switch in its title row, and turns off from it', () => {
    const update = vi.fn(async () => null)
    render(<BotTidyUpSection bot={bot} update={update} />)
    expect(screen.getAllByText('Each night after 3 AM').length).toBeGreaterThan(0)
    const toggle = screen.getByRole('switch', { name: 'Memory upkeep' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ tidyUp: { on: false } })
  })

  it('says Off, and what it would do, while off', () => {
    render(
      <BotTidyUpSection bot={{ ...bot, tidyUp: { on: false } }} update={vi.fn(async () => null)} />
    )
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.getByText(/Changes memory files only/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tidy now' })).toBeNull()
  })
})
