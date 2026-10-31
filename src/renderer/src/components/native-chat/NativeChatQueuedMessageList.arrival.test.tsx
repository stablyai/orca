// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { QueuedMessageCard } from '../../../../shared/structured-agent-session-queued-cards'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

vi.mock('../../store', () => {
  const state = { updateSettings: vi.fn() }
  return { useAppStore: (selector: (value: typeof state) => unknown) => selector(state) }
})
// Isolate the real parent's arrival projection from child rendering and sortable work.
vi.mock('./NativeChatQueuedMessageRows', () => ({ NativeChatQueuedMessageRows: () => null }))
vi.mock('./NativeChatQueuedMessageCard', () => ({
  NativeChatQueuedMessageCard: () => null,
  queuedMessageCardCaption: () => null
}))

import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function trackedCards(ids: string[]) {
  let visits = 0
  const cards: QueuedMessageCard[] = ids.map((messageId, at) => ({
    messageId,
    position: at + 1,
    text: 'queued text',
    state: 'waiting',
    hold: 'turn'
  }))
  cards.map = <Result,>(
    callback: (card: QueuedMessageCard, at: number, array: QueuedMessageCard[]) => Result,
    thisArg?: unknown
  ): Result[] =>
    Array.from(cards, (card, at) => {
      visits++
      return callback.call(thisArg, card, at, cards)
    })
  return { cards, count: () => visits, reset: () => (visits = 0) }
}

function element(cards: QueuedMessageCard[], agentName = 'Agent') {
  const controller: StructuredAgentSessionQueuedMessagesController = {
    cards,
    pause: null,
    queueCapable: false,
    clearCapable: true,
    editCapable: false,
    editor: undefined,
    queuePending: null,
    pending: () => null,
    steer: async () => {},
    remove: async () => {},
    edit: async () => {},
    clear: async () => false,
    resume: async () => false,
    steerHead: () => false,
    isWorking: true
  }
  return (
    <TooltipProvider>
      <NativeChatQueuedMessageList
        controller={controller}
        chatWorktreeId={null}
        agentName={agentName}
      />
    </TooltipProvider>
  )
}

it.each([100, 1000])(
  'bounds arrival ID projection at %i cards, with real append and recovery',
  (n) => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(800)
    const ids = Array.from({ length: n }, (_, at) => `card-${at}`)
    const initial = trackedCards(ids)
    const view = render(element(initial.cards))
    const list = view.getByRole('list', { name: 'Queued messages' })
    expect(initial.count()).toBe(n)
    expect(list.scrollTop).toBe(0)
    initial.reset()
    view.rerender(element(initial.cards, 'Agent updated'))
    expect(initial.count()).toBe(0)
    fireEvent.click(view.getByRole('button', { name: 'Queued messages' }))
    expect(list.hidden).toBe(true)
    expect(initial.count()).toBe(0)
    view.rerender(element(initial.cards, 'Agent metadata'))
    expect(initial.count()).toBe(0)
    fireEvent.click(view.getByRole('button', { name: 'Queued messages' }))
    expect(list.hidden).toBe(false)
    expect(initial.count()).toBe(0)

    // A real append with simultaneous removal still projects the current N IDs and reveals it.
    const appended = trackedCards([...ids.slice(1), 'own-append'])
    view.rerender(element(appended.cards))
    expect(appended.count()).toBe(n)
    expect(list.scrollTop).toBe(800)
    appended.reset()
    view.rerender(element(appended.cards, 'Agent settled'))
    expect(appended.count()).toBe(0)

    view.rerender(element([]))
    expect(view.queryByRole('list')).toBeNull()
    const recovered = trackedCards(ids)
    view.rerender(element(recovered.cards))
    const recoveredList = view.getByRole('list', { name: 'Queued messages' })
    expect(recovered.count()).toBe(n)
    expect(recoveredList.scrollTop).toBe(0)
    const afterRecovery = trackedCards([...ids, 'own-after-recovery'])
    view.rerender(element(afterRecovery.cards))
    expect(afterRecovery.count()).toBe(n + 1)
    expect(recoveredList.scrollTop).toBe(800)
  }
)
