// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { BotSharedFromLine } from './BotSharedFromLine'

const review = vi.hoisted(() => vi.fn(async (_shareId: string, _versionId: string) => null))
vi.mock('../sharing/bot-share-rpc', () => ({ reviewBotShare: review }))

const bot: Bot = {
  id: 'bot-1',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const fromLink: Bot = {
  ...bot,
  sharedFrom: {
    shareId: 'share-1',
    packageId: 'package-1',
    versionId: 'version-1',
    sharedBy: 'Dara',
    sharedAt: 'not a date'
  }
}

describe('BotSharedFromLine', () => {
  afterEach(cleanup)

  it('shows nothing for a bot not made from a link', () => {
    const { container } = render(<BotSharedFromLine bot={bot} />)
    expect(container.textContent).toBe('')
  })

  it('reads the version the bot was made from, and says so when its link no longer serves it', async () => {
    render(<BotSharedFromLine bot={fromLink} />)
    expect(screen.getByText(/Shared by Dara/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View original' }))
    })
    expect(review).toHaveBeenCalledWith('share-1', 'version-1')
    expect(screen.getByRole('status').textContent).toBe('No longer available')
  })
})
