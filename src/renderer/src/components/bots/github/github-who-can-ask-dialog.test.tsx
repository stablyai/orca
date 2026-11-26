// @vitest-environment happy-dom
// Who can ask › Add on GitHub with the real access confirmation: the gesture that opened it (a
// held Enter on Add, a double-click) answers neither of its buttons; a fresh press does, once.
// Setup's turn-on step with the production service and grant path. Synthetic data only.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import {
  addButton,
  gitHubView,
  HostedWhoCanAsk,
  optionTexts,
  pickRow,
  rosterOf,
  searchBox,
  settle,
  usersOf
} from './github-who-can-ask-mount'

const host = vi.hoisted(() => {
  let view: unknown = null
  const listeners = new Set<() => void>()
  return {
    calls: {
      people: vi.fn<(args: unknown) => Promise<unknown>>(),
      users: vi.fn<(args: { query: string }) => Promise<unknown>>()
    },
    update:
      vi.fn<
        (
          bot: unknown,
          updates: { addMembers?: { id: string; name: string }[] }
        ) => Promise<undefined>
      >(),
    read: () => view,
    publish: (next: unknown) => {
      view = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
})

vi.mock('@/lib/bot-github-state', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react')
  return {
    ...(await importOriginal<object>()),
    useBotGitHubRead: () => useSyncExternalStore(host.subscribe, host.read)
  }
})
vi.mock('@/lib/bot-connector-host-calls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  botGitHubCalls: () => host.calls
}))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateBot: host.update,
  useHostBots: () => []
}))
vi.mock('@/lib/bot-host-orca-account', () => ({ useBotHostOnOwnAccount: () => true }))
vi.mock('../orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => 'This Mac' }))

const user = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
// The confirmation, by its own answer button (the picker's popover is a dialog too).
const dialog = () => screen.queryByRole('button', { name: 'Give access' })
const button = (name: string) => screen.getByRole('button', { name })

/** Ticks Maya and presses Enter on the focused Add: the confirmation opens on Cancel. */
async function openedByEnter(): Promise<ReturnType<typeof user>> {
  render(
    <ConfirmationDialogProvider>
      <HostedWhoCanAsk />
    </ConfirmationDialogProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add people' }))
  await settle(300)
  pickRow('maya-cMaya C')
  const keys = user()
  addButton().focus()
  await keys.keyboard('{Enter}')
  await settle()
  expect(dialog()).toBeTruthy()
  expect(document.activeElement).toBe(button('Cancel'))
  return keys
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  host.publish(gitHubView())
  host.calls.people.mockResolvedValue({
    ok: true,
    value: rosterOf([{ id: '41', login: 'maya-c', name: 'Maya C' }])
  })
  host.calls.users.mockResolvedValue(usersOf([]))
  host.update.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('GPS-C8-02: the gesture that opened the confirmation answers neither button', () => {
  it('a held Enter, now repeating on Cancel, and a double-click keep it open with nothing written', async () => {
    await openedByEnter()
    // The held key repeats on the focused Cancel: its default (a click) is withheld.
    expect(fireEvent.keyDown(button('Cancel'), { key: 'Enter', repeat: true })).toBe(false)
    expect(fireEvent.keyDown(button('Give access'), { key: 'Enter', repeat: true })).toBe(false)
    // The second click of a double-click on either button doesn't answer.
    fireEvent.click(button('Cancel'), { detail: 2 })
    fireEvent.click(button('Give access'), { detail: 2 })
    await settle()
    expect(dialog()).toBeTruthy()
    expect(host.update).not.toHaveBeenCalled()
  })

  it('a fresh Enter on the focused Cancel answers it, and nothing is written', async () => {
    const keys = await openedByEnter()
    await keys.keyboard('{Enter}')
    await settle()
    expect(dialog()).toBeNull()
    expect(host.update).not.toHaveBeenCalled()
  })

  it('Escape leaves it, and nothing is written', async () => {
    const keys = await openedByEnter()
    await keys.keyboard('{Escape}')
    await settle()
    expect(dialog()).toBeNull()
    expect(host.update).not.toHaveBeenCalled()
  })

  it('a fresh Enter on the focused Give access writes once', async () => {
    const keys = await openedByEnter()
    button('Give access').focus()
    await keys.keyboard('{Enter}')
    await settle()
    expect(dialog()).toBeNull()
    expect(host.update).toHaveBeenCalledOnce()
  })

  it('a fresh pointer press of Give access writes once', async () => {
    const keys = await openedByEnter()
    await keys.click(button('Give access'))
    await settle()
    expect(dialog()).toBeNull()
    expect(host.update).toHaveBeenCalledOnce()
    expect(host.update.mock.calls[0]?.[1].addMembers).toEqual([
      expect.objectContaining({ id: '41', name: 'maya-c', source: 'github' })
    ])
  })

  it('Enter in the search still ticks the highlighted row; Add appears only once someone is ticked', async () => {
    render(
      <ConfirmationDialogProvider>
        <HostedWhoCanAsk />
      </ConfirmationDialogProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add people' }))
    const keys = user()
    await keys.type(searchBox(), 'maya')
    await settle(300)
    expect(optionTexts()).toContain('maya-cMaya C')
    expect(screen.queryByRole('button', { name: /^Add (1 person|\d+ people)$/ })).toBeNull()
    await keys.keyboard('{Enter}')
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(dialog()).toBeNull()
  })
})
