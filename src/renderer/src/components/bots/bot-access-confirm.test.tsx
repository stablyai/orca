// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
// The real catalog snapshot, without the host reads the app starts on first subscribe.
vi.mock('@/lib/bot-catalog', async () => {
  const { useSyncExternalStore } = await import('react')
  const snapshot = await import('@/lib/bot-catalog-snapshot')
  return {
    useHostBots: (hostId: Parameters<typeof snapshot.readHostBots>[0]) =>
      useSyncExternalStore(snapshot.subscribeToBotChanges, () => snapshot.readHostBots(hostId))
  }
})

import { publishBots } from '@/lib/bot-catalog-snapshot'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import type { Bot } from '../../../../shared/bot-types'
import { useConfirmBotAccess, type BotAccessConfirm } from './bot-access-confirm'

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: 'mascot:Q1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  permissionMode: 'ask',
  google: false
}
const noGoogleService = { client: null, accounts: [], bots: [] }

function Harness({ grant }: { grant: BotAccessConfirm }): React.JSX.Element {
  const confirm = useConfirmBotAccess()
  return (
    <button type="button" onClick={() => void confirm(grant)}>
      open
    </button>
  )
}

function renderHarness(asked: Bot): void {
  render(
    <ConfirmationDialogProvider>
      <Harness
        grant={{
          botName: asked.name,
          people: [{ id: 'U1', name: 'Neil' }],
          details: { bot: asked, connector: 'slack' },
          connector: 'Slack',
          workspace: 'Stably'
        }}
      />
    </ConfirmationDialogProvider>
  )
}

// What the person reaches, one row each; a Google row is the one these cases add or take away.
const rowCount = (): number => within(screen.getByRole('dialog')).getAllByRole('listitem').length

beforeEach(() => {
  mocks.rpc.mockReset()
  publishBots([bot])
})
afterEach(cleanup)

describe('the Give access confirm', () => {
  it('follows the bot as listed now while it is open', async () => {
    mocks.rpc.mockReturnValue(new Promise(() => {}))
    renderHarness(bot)
    await userEvent.click(screen.getByRole('button', { name: 'open' }))
    await screen.findByRole('dialog')
    expect(rowCount()).toBe(3)

    // Google turned on while open: its status hasn't been read, so it may reach anything.
    act(() => publishBots([{ ...bot, google: true }]))
    expect(rowCount()).toBe(4)
    act(() => publishBots([bot]))
    expect(rowCount()).toBe(3)
  })

  it('reads a bot its host no longer lists as reaching Google', async () => {
    mocks.rpc.mockReturnValue(new Promise(() => {}))
    renderHarness(bot)
    await userEvent.click(screen.getByRole('button', { name: 'open' }))
    await screen.findByRole('dialog')
    expect(rowCount()).toBe(3)

    act(() => publishBots([]))
    expect(rowCount()).toBe(4)
  })

  it('reads Google again for a confirm queued behind one that found no access', async () => {
    const withGoogle: Bot = { ...bot, google: true }
    publishBots([withGoogle])
    mocks.rpc.mockResolvedValue(noGoogleService)
    renderHarness(withGoogle)
    const open = screen.getByRole('button', { name: 'open' })
    await userEvent.click(open)
    await screen.findByRole('dialog')
    await waitFor(() => expect(rowCount()).toBe(3))

    // The second waits behind the first; its own read hasn't answered when it shows.
    mocks.rpc.mockReturnValue(new Promise(() => {}))
    // The open dialog makes the page behind it inert to the pointer, not to a direct click.
    fireEvent.click(open)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(rowCount()).toBe(4))
  })
})
