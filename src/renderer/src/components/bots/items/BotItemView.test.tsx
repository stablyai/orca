// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemViewRead } from './use-bot-item-view'

const read = vi.hoisted((): { current: BotItemViewRead | null } => ({ current: null }))
const sent = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('./use-bot-item-view', () => ({ useBotItemView: () => read.current }))
const answered = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve('answered')))
const statusSet = vi.hoisted(() => vi.fn())
vi.mock('./use-bot-items', () => ({
  commentOnBotItem: sent,
  setBotItemsStatus: statusSet,
  answerBotItem: answered
}))
const fileContextOwners = vi.hoisted(() => vi.fn((..._args: unknown[]) => new Map()))
vi.mock('../BotGroupTranscriptOwner', () => ({ useBotGroupFileContexts: fileContextOwners }))
const openAppHttpLink = vi.hoisted(() => vi.fn())
vi.mock(import('@/lib/browser/navigation/app-http-link-open'), async (importOriginal) => ({
  ...(await importOriginal()),
  openAppHttpLink
}))
vi.mock('./BotItemActivityList', () => ({
  BotItemActivityList: ({
    events,
    onReplyToQuestion
  }: {
    events: BotItemEvent[]
    onReplyToQuestion?: (text: string) => void
  }) => (
    <ol>
      {events.map((event) => (
        <li key={event.id}>{event.id}</li>
      ))}
      {onReplyToQuestion ? (
        <button type="button" onClick={() => onReplyToQuestion('b, by hand')}>
          Reply from Activity
        </button>
      ) : null}
    </ol>
  )
}))

import { BotItemView } from './BotItemView'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { changePrompt } from '../../native-chat/composer/editor/native-chat-prompt-editor.test-support'

// The app root provides tooltips; the mic's needs it here too.
const render = (ui: React.ReactElement) => renderBare(ui, { wrapper: TooltipProvider })

const BOT: Bot = {
  id: 'bot-a',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const VIEWPORT = 200
const CONTENT = 1000

function eventsUpTo(count: number): BotItemEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${index + 1}`,
    kind: 'commented',
    actor: { kind: 'owner' },
    data: {},
    at: index
  }))
}

function show(count: number, item = makeTestBotItem(6)): void {
  read.current = {
    item,
    events: eventsUpTo(count),
    eventsRead: true,
    hasEarlier: false,
    failed: false,
    deleted: false,
    loadEarlier: vi.fn(),
    retry: vi.fn()
  }
}

function scroller(): HTMLElement {
  const node = screen.getByText('e1').closest<HTMLElement>('.overflow-y-auto')
  if (!node) {
    throw new Error('no scroller')
  }
  return node
}

function readerScrollsToTop(): void {
  const node = scroller()
  fireEvent.wheel(node, { deltaY: -400 })
  node.scrollTop = 0
  fireEvent.scroll(node)
}

const pill = (): HTMLElement => screen.getByText('Jump to latest').closest('button')!

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(CONTENT)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sent.mockReset()
  statusSet.mockReset()
  // Back to its own implementation, so one test's refusal never reaches the next.
  answered.mockReset()
  openAppHttpLink.mockClear()
  fileContextOwners.mockReturnValue(new Map())
})

it('follows new events until the reader scrolls up, then offers Jump to latest', () => {
  show(3)
  const view = render(<BotItemView bot={BOT} uid="uid-6" />)
  expect(scroller().scrollTop).toBe(CONTENT)

  scroller().scrollTop = 0
  show(4)
  view.rerender(<BotItemView bot={BOT} uid="uid-6" />)
  expect(scroller().scrollTop).toBe(CONTENT)
  expect(pill().dataset.shown).toBe('false')

  readerScrollsToTop()
  expect(pill().dataset.shown).toBe('true')

  show(5)
  view.rerender(<BotItemView bot={BOT} uid="uid-6" />)
  expect(scroller().scrollTop).toBe(0)

  fireEvent.click(pill())

  expect(scroller().scrollTop).toBe(CONTENT)
  expect(pill().dataset.shown).toBe('false')
})

it('scrolls to the end after a comment is sent', async () => {
  show(3)
  render(<BotItemView bot={BOT} uid="uid-6" />)
  readerScrollsToTop()
  const box = screen.getByRole('textbox', { name: 'Comment' })
  changePrompt(box, 'Ship it')

  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
  })

  expect(sent).toHaveBeenCalledWith(BOT, 'uid-6', 'Ship it', [], expect.any(String))
  expect(scroller().scrollTop).toBe(CONTENT)
})

it('focuses the comment box from its card and preserves focus outside it when submitting', async () => {
  show(3, makeTestBotItem(6, { question: { eventId: 'e3', text: 'Which flow?' } }))
  render(<BotItemView bot={BOT} uid="uid-6" />)

  fireEvent.click(document.querySelector('[data-native-chat-composer-scope]')!)

  const box = screen.getByRole('textbox', { name: 'Comment' })
  expect(document.activeElement).toBe(box)
  changePrompt(box, 'Use the proposed flow')
  box.blur()
  expect(box.contains(document.activeElement)).toBe(false)

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })))

  expect(sent).toHaveBeenCalledExactlyOnceWith(
    BOT,
    'uid-6',
    'Use the proposed flow',
    [],
    expect.any(String)
  )
  expect(box.contains(document.activeElement)).toBe(false)
})

it('places its file opens beside the bot workspace focused tab, as a click in that chat would', () => {
  const initial = useAppStore.getState()
  useAppStore.setState({
    groupsByWorktree: {
      'folder:w1': [
        makeTabGroup({ id: 'g-left', worktreeId: 'folder:w1', activeTabId: 'other' }),
        makeTabGroup({ id: 'g-chat', worktreeId: 'folder:w1', activeTabId: 'chat-tab' })
      ]
    },
    activeGroupIdByWorktree: { 'folder:w1': 'g-chat' },
    unifiedTabsByWorktree: {
      'folder:w1': [
        makeUnifiedTab({ id: 'other', worktreeId: 'folder:w1', groupId: 'g-left' }),
        makeUnifiedTab({ id: 'chat-tab', worktreeId: 'folder:w1', groupId: 'g-chat' })
      ]
    }
  })
  try {
    show(1)
    render(<BotItemView bot={BOT} uid="uid-6" />)

    expect(fileContextOwners).toHaveBeenLastCalledWith([], BOT, 'chat-tab')
  } finally {
    useAppStore.setState(initial, true)
  }
})

const PR_URL = 'https://github.com/acme/app/pull/9'

function showPrLink(): void {
  const context = {
    worktreeId: 'folder:w1',
    worktreePath: '/bots/bot-builder',
    runtimeEnvironmentId: null
  }
  fileContextOwners.mockReturnValue(
    new Map([
      [
        BOT.id,
        { fileLinkContext: context, runtimeContext: { target: { kind: 'local' }, ...context } }
      ]
    ])
  )
  show(1, { ...makeTestBotItem(6), links: [{ kind: 'url', ref: PR_URL }] })
  render(<BotItemView bot={BOT} uid="uid-6" />)
}

it('opens a PR link in the workspace card’s link popover', () => {
  showPrLink()
  fireEvent.click(screen.getByRole('button', { name: /#9/ }))

  const popover = document.querySelector<HTMLElement>('[data-link-action-popover]')!
  expect(within(popover).getByText(PR_URL)).toBeTruthy()
  expect(within(popover).getByRole('button', { name: 'Copy link' })).toBeTruthy()
  expect(within(popover).getByText('System Browser')).toBeTruthy()
  expect(openAppHttpLink).not.toHaveBeenCalled()
})

it('sends a plain click the link setting leaves alone to the system browser, as the workspace card does', () => {
  const initial = useAppStore.getState()
  useAppStore.setState({ settings: { ...initial.settings!, terminalLinkClickBehavior: 'none' } })
  try {
    showPrLink()
    fireEvent.click(screen.getByRole('button', { name: /#9/ }))

    expect(document.querySelector('[data-link-action-popover]')).toBeNull()
    expect(openAppHttpLink).toHaveBeenCalledWith(
      PR_URL,
      expect.objectContaining({ destination: 'system' })
    )
  } finally {
    useAppStore.setState(initial, true)
  }
})

const OPEN_ASK = makeTestBotItem(6, {
  status: 'needs_you',
  question: { eventId: 'e3', text: 'Which flow should ship?', answerable: true }
})

function renderItem(item: ReturnType<typeof makeTestBotItem>): void {
  show(3, item)
  render(
    <TooltipProvider>
      <BotItemView bot={BOT} uid="uid-6" />
    </TooltipProvider>
  )
}

it("puts the open question's card in the comment box's place and sends its answer to that question", () => {
  renderItem(OPEN_ASK)

  expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
  fireEvent.change(screen.getByPlaceholderText('Type your answer'), {
    target: { value: 'The short one' }
  })
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))

  expect(answered).toHaveBeenCalledWith(
    BOT,
    'uid-6',
    'e3',
    [{ picks: [], text: 'The short one' }],
    expect.any(String)
  )
  expect(sent).not.toHaveBeenCalled()
})

it('gives the comment box back when the card is folded, and the strip opens it again', () => {
  renderItem(OPEN_ASK)

  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
  expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
  expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
})

it('keeps the comment box for a question asked where answers are not recorded', () => {
  renderItem(
    makeTestBotItem(6, { status: 'needs_you', question: { eventId: 'e3', text: 'Which flow?' } })
  )

  expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy()
  expect(screen.queryByPlaceholderText('Type your answer')).toBeNull()
})

it("sends a Reply from an open question's card in Activity as the item's comment", async () => {
  renderItem(
    makeTestBotItem(6, { status: 'needs_you', question: { eventId: 'e3', text: 'a, b or c?' } })
  )

  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Reply from Activity' }))
  )

  expect(sent).toHaveBeenCalledExactlyOnceWith(BOT, 'uid-6', 'b, by hand', [], expect.any(String))
  expect(answered).not.toHaveBeenCalled()
})

function askingItem(
  number: number,
  question: Partial<NonNullable<ReturnType<typeof makeTestBotItem>['question']>> = {}
) {
  return makeTestBotItem(number, {
    status: 'needs_you',
    question: { eventId: 'e3', text: 'Which flow should ship?', answerable: true, ...question }
  })
}

function renderAt(item: ReturnType<typeof makeTestBotItem>, events = 3): ReturnType<typeof render> {
  show(events, item)
  return render(
    <TooltipProvider>
      <BotItemView bot={BOT} uid={item.uid} />
    </TooltipProvider>
  )
}

function typeAnswer(text: string): void {
  fireEvent.change(screen.getByPlaceholderText('Type your answer'), { target: { value: text } })
}

it('keeps the answer being typed when the question is replaced, and offers it back', () => {
  const view = renderAt(askingItem(21))
  typeAnswer('The short one')

  const replaced = askingItem(21, { eventId: 'e9', text: 'Which color?' })
  show(9, replaced)
  view.rerender(
    <TooltipProvider>
      <BotItemView bot={BOT} uid={replaced.uid} />
    </TooltipProvider>
  )

  const notice = screen.getByRole('status')
  expect(notice.textContent).toContain('Which flow should ship?')
  expect(notice.textContent).toContain('The short one')
  expect(screen.getByPlaceholderText('Type your answer')).toHaveProperty('value', '')
})

/** Nothing but the answer itself ever reached the host: no comment and no status move. */
function expectOnlyAnswerCalls(): void {
  expect(sent).not.toHaveBeenCalled()
  expect(statusSet).not.toHaveBeenCalled()
}

it("shows the bot's context in the card while the question's event is off the loaded page", () => {
  renderAt(
    askingItem(24, {
      eventId: 'e40',
      ask: {
        context: 'It deletes worktrees idle for 30+ days.',
        questions: [
          { prompt: 'Which environment?', options: [{ label: 'Staging' }, { label: 'Prod' }] }
        ]
      }
    })
  )

  expect(screen.getByText('It deletes worktrees idle for 30+ days.')).toBeTruthy()
})

function rerenderable(item: ReturnType<typeof makeTestBotItem>): {
  reconcileTo: (next: ReturnType<typeof makeTestBotItem>, events: BotItemEvent[]) => void
} {
  let view: ReturnType<typeof render> | null = null
  let next: { item: ReturnType<typeof makeTestBotItem>; events: BotItemEvent[] } | null = null
  show(3, item)
  // The view's re-read: what the host holds once asked again.
  read.current!.retry = () => {
    if (next) {
      read.current = { ...read.current!, item: next.item, events: next.events }
      view?.rerender(
        <TooltipProvider>
          <BotItemView bot={BOT} uid={item.uid} />
        </TooltipProvider>
      )
    }
  }
  view = render(
    <TooltipProvider>
      <BotItemView bot={BOT} uid={item.uid} />
    </TooltipProvider>
  )
  return {
    reconcileTo: (nextItem, events) => {
      next = { item: nextItem, events }
    }
  }
}

const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

it("never calls the owner's own recorded answer someone else's when its reply was lost", async () => {
  let loseReply: (error: Error) => void = () => {}
  answered.mockImplementationOnce(() => new Promise((_, reject) => (loseReply = reject)))
  const page = rerenderable(askingItem(31))
  typeAnswer('Ship B')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  const sentId = answered.mock.calls[0]![4]
  // The change notice's read lands first: the answer, under this card's id, took the question.
  page.reconcileTo(makeTestBotItem(31, { status: 'working', question: null }), [
    ...eventsUpTo(3),
    {
      id: 'e4',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: {
        text: 'Ship B',
        decisions: [{ picks: [], text: 'Ship B' }],
        answers: 'e3',
        answerId: sentId
      },
      at: 4
    }
  ])
  act(() => read.current!.retry())
  loseReply(new Error('connection lost'))
  await flush()

  expect(screen.queryByRole('status')).toBeNull()
})

it('reads the item again when the host says the question closed, and offers the answer back', async () => {
  answered.mockResolvedValueOnce('closed')
  const page = rerenderable(askingItem(32))
  page.reconcileTo(askingItem(32, { eventId: 'e9', text: 'Which color?' }), eventsUpTo(9))
  typeAnswer('Ship B')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()

  expect(screen.getByRole('status').textContent).toContain('Ship B')
})

it("knows an earlier attempt's recorded answer as its own after a changed answer was sent", async () => {
  answered.mockRejectedValueOnce(new Error('connection lost'))
  const page = rerenderable(askingItem(35))
  typeAnswer('Ship A')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()
  const firstId = answered.mock.calls[0]![4]
  // A took the question; the changed answer B is refused as closed, and the read shows A.
  answered.mockResolvedValueOnce('closed')
  page.reconcileTo(makeTestBotItem(35, { status: 'working', question: null }), [
    ...eventsUpTo(3),
    {
      id: 'e4',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: {
        text: 'Ship A',
        decisions: [{ picks: [], text: 'Ship A' }],
        answers: 'e3',
        answerId: firstId
      },
      at: 4
    }
  ])
  typeAnswer('Ship B')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()

  expect(answered.mock.calls[1]![4]).not.toBe(firstId)
  // A is known as this card's own; B, changed after it, stays.
  expect(screen.getByRole('status').textContent).toContain('Your answer was recorded')
})

it('shows what the host holds after a recorded answer, with no change notice needed', async () => {
  const page = rerenderable(askingItem(36))
  page.reconcileTo(makeTestBotItem(36, { status: 'working', question: null }), eventsUpTo(4))
  typeAnswer('Ship B')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()

  expect(screen.queryByPlaceholderText('Type your answer')).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy()
})

it('shows the first empty step instead of sending when the last step is picked first', async () => {
  renderAt(
    askingItem(34, {
      ask: {
        questions: [
          { prompt: 'Ready title?', options: [{ label: 'A' }, { label: 'B' }] },
          { prompt: 'Merge after?', options: [{ label: 'Yes' }, { label: 'No' }] }
        ]
      }
    })
  )
  fireEvent.click(screen.getByRole('button', { name: /Step 2/ }))
  fireEvent.click(screen.getByRole('button', { name: /Yes/ }))

  // The pick's auto-submit lands on the first empty step instead of sending.
  await vi.waitFor(() => expect(screen.getByText('Ready title?')).toBeTruthy())
  expect(answered).not.toHaveBeenCalled()
})

it('keeps what the owner changed after sending when that earlier answer turns out recorded', async () => {
  answered.mockRejectedValueOnce(new Error('connection lost'))
  const page = rerenderable(askingItem(41))
  typeAnswer('Ship A')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()
  const firstId = answered.mock.calls[0]![4]
  typeAnswer('Ship B instead')
  page.reconcileTo(makeTestBotItem(41, { status: 'working', question: null }), [
    ...eventsUpTo(3),
    {
      id: 'e4',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: {
        text: 'Ship A',
        decisions: [{ picks: [], text: 'Ship A' }],
        answers: 'e3',
        answerId: firstId
      },
      at: 4
    }
  ])
  act(() => read.current!.retry())
  await flush()

  expect(screen.getByRole('status').textContent).toContain('Ship B instead')
})

it("writes nothing for an older host's refusal when the question is replaced while the answer is out", async () => {
  let refuse: (outcome: string) => void = () => {}
  answered.mockImplementationOnce(() => new Promise((resolve) => (refuse = resolve)))
  const page = rerenderable(askingItem(36))
  typeAnswer('Ship B')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  // Q2 replaces Q1 after the answer went and before the host's refusal comes back.
  page.reconcileTo(askingItem(36, { eventId: 'e9', text: 'Which color?' }), eventsUpTo(9))
  act(() => read.current!.retry())
  refuse('unsupported')
  await flush()

  expectOnlyAnswerCalls()
  expect(answered).toHaveBeenCalledExactlyOnceWith(
    BOT,
    'uid-36',
    'e3',
    expect.anything(),
    expect.any(String)
  )
  const notice = screen.getByRole('status')
  expect(notice.textContent).toContain('can’t record answers yet')
  expect(notice.textContent).toContain('Ship B')
})

it('writes nothing on retries to an older host, before or after the question is replaced', async () => {
  answered.mockResolvedValue('unsupported')
  const page = rerenderable(askingItem(37))
  typeAnswer('Ship B')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()
  const notice = screen.getByRole('status')
  expect(notice.textContent).toContain('can’t record answers yet, so nothing was sent')
  expect(notice.textContent).toContain('Ship B')
  expect(within(notice).queryByRole('button', { name: 'Draft comment' })).toBeNull()

  // The owner opens the card again and sends the same answer.
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()
  // Then Q2 replaces Q1, and the owner answers it too.
  page.reconcileTo(askingItem(37, { eventId: 'e9', text: 'Which color?' }), eventsUpTo(9))
  act(() => read.current!.retry())
  typeAnswer('Blue')
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
  await flush()

  expectOnlyAnswerCalls()
  expect(answered.mock.calls.map((call) => call[2])).toEqual(['e3', 'e3', 'e9'])
})

const ENVIRONMENT = {
  questions: [{ prompt: 'Which environment?', options: [{ label: 'Staging' }, { label: 'Prod' }] }]
}

function recordedUnder(answerId: unknown): BotItemEvent[] {
  return [
    ...eventsUpTo(3),
    {
      id: 'e4',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: { text: 'Staging', decisions: [{ picks: [0] }], answers: 'e3', answerId },
      at: 4
    }
  ]
}

async function pickStaging(): Promise<void> {
  const sends = answered.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: /Staging/ }))
  // A single-choice pick submits after the card's short pause.
  await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(sends + 1))
  await flush()
}

it('keeps words never sent when the same answer is retried and its first send turns out recorded', async () => {
  answered.mockRejectedValueOnce(new Error('connection lost'))
  answered.mockRejectedValueOnce(new Error('connection lost'))
  const page = rerenderable(askingItem(51, { ask: ENVIRONMENT }))
  await pickStaging()
  const firstId = answered.mock.calls[0]![4]
  // Words typed after the send, left unchosen; the same pick goes again under the same id.
  typeAnswer('only after the freeze')
  await pickStaging()
  expect(answered.mock.calls[1]![4]).toBe(firstId)
  page.reconcileTo(
    makeTestBotItem(51, { status: 'working', question: null }),
    recordedUnder(firstId)
  )
  act(() => read.current!.retry())
  await flush()

  expect(screen.getByRole('status').textContent).toContain('only after the freeze')
})

it('offers back words typed before the first send that the answer left out', async () => {
  answered.mockRejectedValueOnce(new Error('connection lost'))
  const page = rerenderable(askingItem(52, { ask: ENVIRONMENT }))
  typeAnswer('ask Ops first')
  await pickStaging()
  const firstId = answered.mock.calls[0]![4]
  page.reconcileTo(
    makeTestBotItem(52, { status: 'working', question: null }),
    recordedUnder(firstId)
  )
  act(() => read.current!.retry())
  await flush()

  expect(screen.getByRole('status').textContent).toContain('ask Ops first')
})

it('keeps focus in the item, with its arrows, when it is deleted while its comment box has focus', () => {
  const nothingFocused = (): boolean =>
    document.activeElement === null || document.activeElement === document.body
  const nav = <button type="button">Next item</button>
  show(3)
  const view = render(<BotItemView bot={BOT} uid="uid-6" takeFocus={nothingFocused} nav={nav} />)
  const box = screen.getByRole('textbox', { name: 'Comment' })
  box.focus()
  expect(document.activeElement).toBe(box)

  read.current = { ...read.current!, deleted: true }
  view.rerender(<BotItemView bot={BOT} uid="uid-6" takeFocus={nothingFocused} nav={nav} />)
  expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
  expect(document.activeElement).toBe(document.querySelector('[data-bot-item-focus-home]'))
  expect(screen.getByRole('button', { name: 'Next item' })).toBeTruthy()
})

it("keeps the arrows below an open question's card, and puts them back in the comment box when it folds", () => {
  show(3, OPEN_ASK)
  const nav = <button type="button">Next item</button>
  render(
    <TooltipProvider>
      <BotItemView bot={BOT} uid="uid-6" nav={nav} />
    </TooltipProvider>
  )
  // Hidden ones too: the box behind the card must not hold a second, unseen set.
  const arrows = (): HTMLElement[] =>
    screen.getAllByRole('button', { name: 'Next item', hidden: true })
  expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
  expect(arrows()).toHaveLength(1)
  expect(arrows()[0].closest('[data-native-chat-composer-scope]')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
  expect(arrows()).toHaveLength(1)
  expect(arrows()[0].closest('[data-native-chat-composer-scope]')).toBe(
    screen.getByRole('textbox', { name: 'Comment' }).closest('[data-native-chat-composer-scope]')
  )
})
