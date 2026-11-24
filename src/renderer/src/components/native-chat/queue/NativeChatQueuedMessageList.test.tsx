// @vitest-environment happy-dom

import React, { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { NativeChatDock } from '../pane/dock/NativeChatDock'
import { NativeChatStructuredPromptCard } from '../prompts/NativeChatStructuredPromptCard'
import type { StructuredPromptItem } from '../../../../../shared/agent-session/view/structured-agent-session-message-projection'
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
    holds: () => false,
    agentMail: [],
    agentMailEditable: () => false,
    mailLeads: false,
    stopping: false,
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

const prompt: StructuredPromptItem = {
  itemId: 'queued-dock-question',
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'question',
    question: 'Which phase?',
    options: [],
    questions: [
      {
        id: 'phase',
        question: 'Which phase?',
        multiSelect: true,
        options: [{ id: 'draft', label: 'Draft' }]
      },
      {
        id: 'scope',
        question: 'Which scope?',
        multiSelect: true,
        options: [{ id: 'full', label: 'Full scope' }]
      }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedAt: null, resolvedBy: null }
  }
}

it('fits the live synchronous card, caps the queue while it is open, and submits only complete answers', async () => {
  const renderedBoxes = new Set([
    'data-native-chat-dock',
    'data-native-chat-queue',
    'data-native-chat-question-card',
    'data-native-chat-dock-clip',
    'data-native-chat-dock-pinned'
  ])
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return [...renderedBoxes].some((attribute) => this.hasAttribute(attribute))
      ? new DOMRect(0, 100, 380, 300)
      : new DOMRect()
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    const rects = [...renderedBoxes].some((attribute) => this.hasAttribute(attribute))
      ? [this.getBoundingClientRect()]
      : []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fitting reads only the rect count.
    return rects as unknown as DOMRectList
  })
  const respond = vi.fn(async () => null)
  const queue = controller([1, 2, 3, 4, 5, 6].map((i) => card(i)))
  function Pane() {
    const answerInputRef = useRef<HTMLTextAreaElement>(null)
    return (
      <TooltipProvider>
        <div data-native-chat-root="">
          <NativeChatDock>
            <NativeChatQueuedMessageList controller={queue} chatWorktreeId={null} />
            <NativeChatStructuredPromptCard
              prompt={prompt}
              promptResponse={{ respond, holds: () => false }}
              onCancel={() => {}}
              shouldFocus={false}
              answerInputRef={answerInputRef}
            />
          </NativeChatDock>
        </div>
      </TooltipProvider>
    )
  }
  const view = render(<Pane />)
  expect(view.container.querySelector('[role="region"][data-native-chat-dock]')).toBeNull()
  expect(screen.getByRole('button', { name: '+3 more' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
  await act(async () => {})
  expect(screen.getAllByRole('listitem')).toHaveLength(6)
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
  await act(async () => {})
  expect(screen.getByRole('button', { name: '+3 more' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Next question' }))
  fireEvent.click(screen.getByRole('button', { name: /full scope/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(respond).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /draft/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(respond).toHaveBeenCalledWith(prompt, {
    kind: 'answers',
    answers: [
      { questionId: 'phase', optionIds: ['draft'] },
      { questionId: 'scope', optionIds: ['full'] }
    ]
  })
})

it('preserves expanded sortable rows and moves focus off a row before reducing the cap', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(220)
  const queue = controller(
    [1, 2, 3, 4, 5, 6].map((i) => card(i)),
    {
      reorder: { scope: 'queued-test', pending: false, move: vi.fn(async () => {}) }
    }
  )
  const pane = (question: boolean) => (
    <TooltipProvider>
      <div data-native-chat-root="">
        <div data-native-chat-dock="">
          <NativeChatQueuedMessageList controller={queue} chatWorktreeId={null} />
          {question ? <div data-native-chat-question-card="" /> : null}
        </div>
      </div>
    </TooltipProvider>
  )
  const view = render(pane(false))
  const rows = screen.getAllByRole('listitem')
  fireEvent.click(screen.getAllByRole('button', { name: 'Show full message' })[0]!)
  const expanded = screen.getByRole('button', { name: 'Show less' })
  act(() => expanded.focus())
  await act(async () => view.rerender(pane(true)))
  expect(screen.getAllByRole('listitem')).toEqual(rows.slice(0, 3))
  expect(screen.getByRole('button', { name: 'Show less' })).toBe(expanded)
  expect(document.activeElement).toBe(expanded)

  await act(async () => view.rerender(pane(false)))
  act(() => screen.getAllByRole('button', { name: 'Send' })[5]!.focus())
  await act(async () => view.rerender(pane(true)))
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Queued' }))
})

// Hidden at rest: the row's tools fade in only on hover or keyboard focus (CSS the test DOM does not run).
function hiddenAtRest(element: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = element;
    node && node.tagName !== 'LI';
    node = node.parentElement
  ) {
    if (
      node.hidden ||
      ['opacity-0', 'invisible', 'hidden', 'sr-only'].some((name) => node!.classList.contains(name))
    ) {
      return true
    }
  }
  return false
}

it('gives every queued row its own Steer at rest, with Edit and Delete hidden until hover or focus', () => {
  const queue = controller([card(1), card(2), card(3)], { isWorking: true })
  renderQueue(queue)
  const rows = screen.getAllByRole('listitem')
  expect(rows).toHaveLength(3)
  rows.forEach((row, index) => {
    const steer = within(row).getByRole('button', { name: 'Steer' })
    expect(hiddenAtRest(steer)).toBe(false)
    expect(hiddenAtRest(within(row).getByRole('button', { name: 'Edit message' }))).toBe(true)
    expect(hiddenAtRest(within(row).getByRole('button', { name: 'Delete' }))).toBe(true)
    // Each Steer sends its own message, not the head's.
    fireEvent.click(steer)
    expect(queue.steer).toHaveBeenLastCalledWith(`m${index + 1}`)
  })
})

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
