// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
// A card's sender line opens and names agents through modules this test does not exercise.
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import type { QueuedMessageCard } from '../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'

import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

import type { AgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'

function renderList(
  owner: StructuredAgentSessionQueuedMessagesController,
  agentName?: string,
  statedFailures?: readonly AgentSessionFailureFact[]
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatQueuedMessageList
        chatWorktreeId={null}
        controller={owner}
        agentName={agentName}
        statedFailures={statedFailures}
      />
    </TooltipProvider>
  )
}

function card(overrides: Partial<QueuedMessageCard> & { messageId: string }): QueuedMessageCard {
  return {
    position: 1,
    text: `text of ${overrides.messageId}`,
    state: 'waiting',
    hold: 'turn',
    ...overrides
  }
}

function controller(
  cards: QueuedMessageCard[],
  pause: { reason: string } | null = null,
  queueCapable = true,
  isWorking = true
): StructuredAgentSessionQueuedMessagesController & {
  steer: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
} {
  return {
    cards,
    queueCapable,
    clearCapable: cards.every((entry) => entry.hold !== 'sending'),
    editCapable: true,
    editor: undefined,
    pause,
    resume: vi.fn(async () => false),
    clear: vi.fn(async () => true),
    queuePending: null,
    pending: () => null,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    steerHead: vi.fn(() => false),
    steerLast: vi.fn(() => false),
    isWorking
  }
}

/** Use host-projected cards after Stop or /clear, when sends stay held. */

afterEach(cleanup)

describe('NativeChatQueuedMessageList', () => {
  it('Clear all deletes every card; the chevron folds only the cards, and an emptied queue opens again', () => {
    const focusComposer = vi.fn()
    const paused = controller([card({ messageId: 'held', hold: 'queue-paused' })], {
      reason: 'stopped'
    })
    const view = render(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          controller={paused}
          focusComposer={focusComposer}
        />
      </TooltipProvider>
    )
    const rerender = (owner: StructuredAgentSessionQueuedMessagesController) =>
      view.rerender(
        <TooltipProvider delayDuration={0}>
          <NativeChatQueuedMessageList chatWorktreeId={null} controller={owner} />
        </TooltipProvider>
      )
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(paused.clear).toHaveBeenCalledOnce()
    const toggle = screen.getByRole('button', { name: 'Queued messages' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('list', { hidden: true }).hidden).toBe(true)
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy()
    rerender(controller([]))
    rerender(controller([card({ messageId: 'next' })]))
    expect(screen.getByRole('list').hidden).toBe(false)
  })

  // Scroll locally queued cards into view; preserve the next-send position for cards from other agents.
  it("scrolls only to a card the person just queued, inside the list's own bound", () => {
    const from = { kind: 'agent' as const, senders: [], orchestration: null }
    const first = [card({ messageId: 'a', position: 1 }), card({ messageId: 'b', position: 2 })]
    const view = renderList(controller(first))
    const list = screen.getByRole('list', { name: 'Queued messages' })
    expect(list.className).toMatch(/\bmax-h-40\b/)
    expect(list.className).toMatch(/\boverflow-y-auto\b/)
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 500 })
    const rerender = (cards: QueuedMessageCard[]): void =>
      view.rerender(
        <TooltipProvider delayDuration={0}>
          <NativeChatQueuedMessageList chatWorktreeId={null} controller={controller(cards)} />
        </TooltipProvider>
      )
    rerender([...first, card({ messageId: 'mail', position: 3, from })])
    expect(list.scrollTop).toBe(0)
    rerender([
      ...first,
      card({ messageId: 'mail', position: 3, from }),
      card({ messageId: 'mine', position: 4 })
    ])
    expect(list.scrollTop).toBe(500)
  })

  it('does not scroll for cards that load after the list mounts', () => {
    // The list mounts with the cards, so its height is stubbed where it will be read.
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
    onTestFinished(() => height.mockRestore())
    const view = renderList(controller([]))
    view.rerender(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          controller={controller([
            card({ messageId: 'a', position: 1 }),
            card({ messageId: 'b', position: 2 })
          ])}
        />
      </TooltipProvider>
    )
    expect(screen.getByRole('list', { name: 'Queued messages' }).scrollTop).toBe(0)
  })

  it('preserves scroll through reorder, settlement and placeholder handoff but reveals a real append', () => {
    const first = ['a', 'b', 'c'].map((messageId, at) => card({ messageId, position: at + 1 }))
    const view = renderList(controller(first))
    const list = screen.getByRole('list', { name: 'Queued messages' })
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 800 })
    list.scrollTop = 30
    const show = (cards: QueuedMessageCard[]) =>
      view.rerender(
        <TooltipProvider delayDuration={0}>
          <NativeChatQueuedMessageList chatWorktreeId={null} controller={controller(cards)} />
        </TooltipProvider>
      )
    const optimistic = [first[2]!, first[0]!, first[1]!]
    show(optimistic)
    expect(list.scrollTop).toBe(30)
    show(optimistic.map((entry, at) => ({ ...entry, position: at + 1 })))
    expect(list.scrollTop).toBe(30)
    show(first)
    expect(list.scrollTop).toBe(30)
    const placeholder = card({ messageId: 'd', position: Number.MAX_SAFE_INTEGER, hold: 'sending' })
    show([first[1]!, first[2]!, placeholder])
    expect(list.scrollTop).toBe(800)
    list.scrollTop = 40
    show([first[1]!, first[2]!, { ...placeholder, position: 4, hold: 'turn' }])
    expect(list.scrollTop).toBe(40)
  })
})
