// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const card = (index: number, extra: Partial<QueuedMessageCard> = {}): QueuedMessageCard => ({
  messageId: `m${index}`,
  position: index,
  text: `Queued message ${index}`,
  state: 'waiting',
  hold: 'turn',
  ...extra
})

function controller(
  cards: QueuedMessageCard[],
  extra: Partial<StructuredAgentSessionQueuedMessagesController> = {}
): StructuredAgentSessionQueuedMessagesController {
  return {
    cards,
    queueCapable: true,
    clearCapable: true,
    pause: null,
    resume: vi.fn(async () => true),
    clear: vi.fn(async () => true),
    queuePending: null,
    pending: () => null,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    editCapable: true,
    editor: undefined,
    edit: vi.fn(async () => {}),
    steerHead: undefined,
    isWorking: false,
    ...extra
  }
}

// The same queue after its question closes: the dock's own item goes, the list stays mounted.
async function cleanupRender(queue: StructuredAgentSessionQueuedMessagesController): Promise<void> {
  rerender(
    <TooltipProvider>
      <div data-native-chat-root="true">
        <div data-native-chat-dock="">
          <NativeChatQueuedMessageList controller={{ ...queue }} chatWorktreeId={null} />
        </div>
      </div>
    </TooltipProvider>
  )
  // The queue learns the question left from a mutation observer on the dock.
  await act(async () => {})
}

let rerender: (ui: React.ReactElement) => void = () => {}

function renderQueue(
  queue: StructuredAgentSessionQueuedMessagesController,
  { questionOpen = false }: { questionOpen?: boolean } = {}
): void {
  rerender = render(
    <TooltipProvider>
      <div data-native-chat-root="true">
        <div data-native-chat-dock="">
          <NativeChatQueuedMessageList controller={queue} chatWorktreeId={null} />
          {questionOpen ? <div data-native-chat-question-card="" /> : null}
        </div>
      </div>
    </TooltipProvider>
  ).rerender
}

it("shows a send-failed card as Couldn't send with Retry, which sends it again", () => {
  const queue = controller([
    card(1),
    card(2, { hold: 'paused', pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
  ])
  renderQueue(queue)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(queue.steer).toHaveBeenCalledWith('m2')
  // The healthy card keeps its Send.
  expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(1)
})

it('shows three rows under an open question with a +N more row that opens the rest', () => {
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))), { questionOpen: true })
  const more = screen.getByRole('button', { name: '+3 more' })
  fireEvent.click(more)
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(screen.getByRole('button', { name: '+3 more' })).toBeTruthy()
})

it('shows one row in a short pane and no +N more when the question is gone and room is normal', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 0, 4)
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))), { questionOpen: true })
  expect(screen.getByRole('button', { name: '+5 more' })).toBeTruthy()
  cleanup()
  vi.restoreAllMocks()
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))))
  expect(screen.queryByRole('button', { name: /more$/ })).toBeNull()
})

it('expands a short pane’s list without a question open', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 0, 4)
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))))
  fireEvent.click(screen.getByRole('button', { name: '+5 more' }))
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
    'true'
  )
})

it('keeps a list folded for room folded while only its header has focus, and says so', async () => {
  renderQueue(controller([card(1), card(2)]))
  const root = document.querySelector('[data-native-chat-root]')!
  // The fit pass sets this attribute in the app; the toggle mirrors it through a mutation observer.
  await act(async () => root.setAttribute('data-native-chat-dock-fit', 'queue'))
  const fold = screen.getByRole('button', { name: /^(Queued|[0-9]+ queued)/i })
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  act(() => fold.focus())
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(root.querySelector('[data-list-focus]')).toBeNull()
  // A row that holds focus keeps the list open, and the toggle reports it.
  act(() => screen.getAllByRole('button', { name: 'Send' })[0]!.focus())
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  act(() => fold.focus())
  expect(fold.getAttribute('aria-expanded')).toBe('false')
})

it('keeps an unconfirmed delivery’s Send instead of calling it a failure', () => {
  renderQueue(
    controller([
      card(1, { state: 'returned', hold: 'returned', returnedRejection: { kind: 'unconfirmed' } })
    ])
  )
  expect(screen.queryByText("Couldn't send")).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
})

it('opens a list the person had folded in one activation once the dock folds it too', async () => {
  renderQueue(controller([card(1), card(2)]))
  const fold = screen.getByRole('button', { name: /^(Queued|[0-9]+ queued)/i })
  fireEvent.click(fold)
  expect(document.querySelector('ul')!.hidden).toBe(true)
  const root = document.querySelector('[data-native-chat-root]')!
  await act(async () => root.setAttribute('data-native-chat-dock-fit', 'queue'))
  fireEvent.click(fold)
  expect(document.querySelector('ul')!.hidden).toBe(false)
  expect(fold.getAttribute('aria-expanded')).toBe('true')
})

it('keeps a list folded for room open while +N more holds focus, and keeps focus on it as it expands', async () => {
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))), { questionOpen: true })
  const root = document.querySelector('[data-native-chat-root]')!
  const fold = screen.getByRole('button', { name: /^(Queued|[0-9]+ queued)/i })
  const more = screen.getByRole('button', { name: '+3 more' })
  act(() => more.focus())
  await act(async () => root.setAttribute('data-native-chat-dock-fit', 'queue'))
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(more)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show less' }))
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  act(() => fold.focus())
  expect(fold.getAttribute('aria-expanded')).toBe('false')
})

it('moves focus into the queue when a focused +N more goes away with the question', async () => {
  const queue = controller([1, 2, 3, 4, 5, 6].map((i) => card(i)))
  renderQueue(queue, { questionOpen: true })
  act(() => screen.getByRole('button', { name: '+3 more' }).focus())
  await cleanupRender(queue)
  expect(screen.queryByRole('button', { name: /more$/ })).toBeNull()
  expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Send' })[0]!)
})

it('leaves focus alone when +N more goes away after the window took focus from it', async () => {
  const queue = controller([1, 2, 3, 4, 5, 6].map((i) => card(i)))
  renderQueue(queue, { questionOpen: true })
  const more = screen.getByRole('button', { name: '+3 more' })
  act(() => more.focus())
  // A window blur: no related target, and the button stays.
  await act(async () => more.blur())
  await cleanupRender(queue)
  expect(screen.queryByRole('button', { name: /more$/ })).toBeNull()
  expect(document.activeElement).toBe(document.body)
})

it('names a later send failure in a folded header when an unconfirmed card comes first', () => {
  renderQueue(
    controller([
      card(1, { state: 'returned', hold: 'returned', returnedRejection: { kind: 'unconfirmed' } }),
      card(2, { hold: 'paused', pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
    ])
  )
  fireEvent.click(screen.getByRole('button', { name: /^(Queued|[0-9]+ queued)/i }))
  expect(screen.getByRole('button', { name: /2 queued.*couldn't send/i })).toBeTruthy()
})
