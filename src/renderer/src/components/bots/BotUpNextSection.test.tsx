// @vitest-environment happy-dom

import type { ReactElement, ReactNode } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotUpNext } from '../../../../shared/bots/bot-look-around'
import type { Bot } from '../../../../shared/bot-types'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  openHome: vi.fn(async () => true),
  openLink: vi.fn(),
  toastMessage: vi.fn(),
  toastError: vi.fn(),
  markSeen: vi.fn(async () => {}),
  setRightSidebarTab: vi.fn(),
  setRightSidebarOpen: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setRightSidebarTab: mocks.setRightSidebarTab,
      setRightSidebarOpen: mocks.setRightSidebarOpen
    })
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/bot-catalog', () => ({ openBotHomeTab: mocks.openHome }))
vi.mock('@/lib/browser/navigation/app-http-link-open', () => ({ openAppHttpLink: mocks.openLink }))
vi.mock('sonner', () => ({ toast: { message: mocks.toastMessage, error: mocks.toastError } }))
vi.mock('@/lib/bot-up-next-unseen', () => ({ markBotUpNextSeen: mocks.markSeen }))
vi.mock('./BotLookSteps', () => ({
  BotLookSteps: ({ sessionId }: { sessionId: string }) => <p>steps of {sessionId}</p>
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { setBotHostListing, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { BotUpNextSection } from './BotUpNextSection'
import { revealBotUpNext } from './bot-up-next-reveal'

function Tooltips({ children }: { children: ReactNode }): React.JSX.Element {
  return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
}
const render = (ui: ReactElement) => renderUi(ui, { wrapper: Tooltips })

/** What a screen reader reads after the control's name. */
function description(element: HTMLElement): string | null {
  const id = element.getAttribute('aria-describedby')
  return id ? (document.getElementById(id)?.textContent ?? null) : null
}

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
const review = {
  id: 's1',
  title: 'Answer Bob’s review comments on PR #1234',
  why: 'Bob requested changes this morning.',
  ask: 'Answer Bob’s comments on stablyai/orca#1234.',
  link: 'https://github.com/stablyai/orca/pull/1234',
  source: 'github' as const,
  createdAt: 1
}
const upNext = (
  overrides: Partial<BotUpNext['state']> = {},
  items: BotUpNext['items'] = [review]
): BotUpNext => ({
  state: {
    running: false,
    lastLookedAt: Date.UTC(2026, 9, 31, 16, 4),
    seenAt: review.createdAt,
    ...overrides
  },
  items
})

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockClear()
  }
})
afterEach(() => cleanup())

describe('Suggestions', () => {
  it('opens a suggestion’s link from its row, and Start puts its request in the Home composer', async () => {
    mocks.rpc.mockResolvedValueOnce({ ask: review.ask })
    render(<BotUpNextSection bot={bot} upNext={upNext()} />)
    fireEvent.click(screen.getByText(review.title))
    // The bot's own workspace hosts it, so Orca's open-links setting applies.
    expect(mocks.openLink).toHaveBeenCalledWith(
      review.link,
      expect.objectContaining({ worktreeId: 'folder:fw-1' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(mocks.openHome).toHaveBeenCalledWith(bot, { draft: review.ask }))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.suggestions.start', {
      botId: 'b1',
      suggestionId: 's1'
    })
  })

  it('dismisses through the host', async () => {
    mocks.rpc.mockResolvedValueOnce({ dismissed: true })
    render(<BotUpNextSection bot={bot} upNext={upNext()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.suggestions.dismiss', {
        botId: 'b1',
        suggestionId: 's1'
      })
    )
  })

  it('shows while looking, and not at all with nothing to suggest', () => {
    const { rerender, container } = render(
      <BotUpNextSection bot={bot} upNext={upNext({ running: true }, [])} />
    )
    expect(screen.getByText('Looking around…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Look now' })).toBeNull()
    rerender(<BotUpNextSection bot={bot} upNext={upNext({}, [])} />)
    expect(container.textContent).toBe('')
  })
})

describe('a suggestion’s whole text', () => {
  it('reads in full from its row, which the hovered row’s actions partly cover', async () => {
    render(<BotUpNextSection bot={bot} upNext={upNext()} />)
    fireEvent.focus(screen.getByRole('button', { name: new RegExp(`^${review.title}`) }))
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toContain(review.title)
    expect(tip.textContent).toContain(review.why)
    expect(tip.textContent).toContain('orca#1234')
  })
})

describe('while the bot’s computer is offline', () => {
  const SERVER = 'runtime:m4' as const
  const serverBot = stampBotHost(SERVER, bot)
  const listHost = (state: 'live' | 'offline') =>
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: SERVER, state }
      ],
      updateNeeded: []
    })
  beforeEach(() => listHost('offline'))
  afterEach(() =>
    setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
  )

  it('describes unavailable actions while offline and enables them on reconnect', async () => {
    render(<BotUpNextSection bot={serverBot} upNext={upNext()} />)
    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start' })
    const dismiss = screen.getByRole<HTMLButtonElement>('button', { name: 'Dismiss' })
    const row = screen.getByRole('button', { name: new RegExp(`^${review.title}`) })
    const descriptionId = start.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    expect(description(start)).toBeTruthy()
    expect(row.getAttribute('aria-describedby')).toBe(descriptionId)
    for (const action of [start, dismiss]) {
      expect(action.disabled).toBe(true)
      expect(action.getAttribute('aria-describedby')).toBe(descriptionId)
    }
    fireEvent.click(start)
    fireEvent.click(dismiss)
    expect(mocks.rpc).not.toHaveBeenCalled()

    mocks.rpc.mockResolvedValueOnce({ dismissed: true })
    act(() => {
      listHost('live')
    })
    const liveDismiss = screen.getByRole<HTMLButtonElement>('button', { name: 'Dismiss' })
    expect(liveDismiss.disabled).toBe(false)
    expect(description(liveDismiss)).toBeNull()
    expect(
      screen
        .getByRole('button', { name: new RegExp(`^${review.title}`) })
        .getAttribute('aria-describedby')
    ).toBeNull()
    fireEvent.click(liveDismiss)
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        expect.anything(),
        'bots.suggestions.dismiss',
        expect.objectContaining({ suggestionId: 's1' })
      )
    )
  })
})

describe('Suggestions while a look starts', () => {
  it('reads Looking around from the click, and again after a refusal it does not', async () => {
    mocks.rpc.mockResolvedValueOnce({})
    render(<BotUpNextSection bot={bot} upNext={upNext({ lastLookedAt: 1 })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Look now' }))
    expect(screen.getByText('Looking around…')).toBeTruthy()
    cleanup()
    mocks.rpc.mockRejectedValueOnce(new Error('look_now_running'))
    render(<BotUpNextSection bot={bot} upNext={upNext({ lastLookedAt: 1 })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Look now' }))
    await waitFor(() => expect(screen.queryByText('Looking around…')).toBeNull())
    expect(mocks.toastMessage).toHaveBeenCalledWith('Already looking around.')
  })
})

describe('Suggestions v2', () => {
  it('opens the running look’s steps from Looking around, with no placeholder row', () => {
    const { container } = render(
      <BotUpNextSection bot={bot} upNext={upNext({ running: true, runSessionId: 'look-1' })} />
    )
    const toggle = screen.getByRole('button', { name: /Looking around…/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.animate-pulse')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('steps of look-1')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByText('steps of look-1')).toBeNull()
  })

  it('has no steps toggle on a host that does not name the look', () => {
    render(<BotUpNextSection bot={bot} upNext={upNext({ running: true })} />)
    expect(screen.queryByRole('button', { name: /Looking around…/ })).toBeNull()
  })

  it('says how many are new since it was last seen, marks them seen, and keeps saying it', async () => {
    const fresh = { ...review, id: 's2', createdAt: 10 }
    const { rerender } = render(
      <BotUpNextSection bot={bot} upNext={upNext({ seenAt: 5 }, [fresh, review])} />
    )
    expect(screen.getByText('1 new')).toBeTruthy()
    await waitFor(() =>
      expect(mocks.markSeen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }))
    )
    // The host now says it was seen; this panel still shows what was new when it opened.
    rerender(<BotUpNextSection bot={bot} upNext={upNext({ seenAt: 20 }, [fresh, review])} />)
    expect(screen.getByText('1 new')).toBeTruthy()
  })

  it('leaves new suggestions unseen while the card is folded, and marks them once it opens', async () => {
    window.localStorage.setItem('orca.bots.panelFolds', JSON.stringify({ b1: ['suggestions'] }))
    try {
      const fresh = { ...review, id: 's2', createdAt: 10 }
      render(<BotUpNextSection bot={bot} upNext={upNext({ seenAt: 5 }, [fresh, review])} />)
      expect(screen.queryByText(fresh.title)).toBeNull()
      expect(mocks.markSeen).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: /Suggestions/, expanded: false }))

      await waitFor(() =>
        expect(mocks.markSeen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }))
      )
    } finally {
      window.localStorage.removeItem('orca.bots.panelFolds')
    }
  })

  it('says nothing is new on a host that does not track it', () => {
    render(<BotUpNextSection bot={bot} upNext={upNext()} />)
    expect(screen.queryByText(/new$/)).toBeNull()
    expect(mocks.markSeen).not.toHaveBeenCalled()
  })
})

describe('the bot row pointing here', () => {
  it('opens the Activity panel and scrolls to Suggestions', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<BotUpNextSection bot={bot} upNext={upNext()} />)

    act(() => revealBotUpNext('b1'))

    expect(mocks.setRightSidebarTab).toHaveBeenCalledWith('bot-activity')
    expect(mocks.setRightSidebarOpen).toHaveBeenCalledWith(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})
