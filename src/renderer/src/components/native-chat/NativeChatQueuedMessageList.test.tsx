// @vitest-environment happy-dom

// The card stack above the composer: an accessible, labeled live list whose
// rows expose Steer/Send, Delete, and the Edit / Turn-off-queueing menu, with
// captions derived client-side per state.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
// A card's sender line opens and names agents through modules this test does not exercise.
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))
vi.mock('../../store', () => {
  const state = { updateSettings: mocks.updateSettings }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { queuedMessageCardSendNow } from './NativeChatQueuedMessageCard'
import {
  useStructuredAgentSessionQueuedMessages,
  type StructuredAgentSessionQueuedMessagesController
} from './use-structured-agent-session-queued-messages'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { AgentSessionQueuePause } from '../../../../shared/agent-session-queued-message-wire'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'

function renderList(
  owner: StructuredAgentSessionQueuedMessagesController,
  agentName?: string,
  statedFailures?: readonly AgentSessionFailureFact[]
) {
  // The app root mounts the provider; tests supply the same context.
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
  queueCapable = true
): StructuredAgentSessionQueuedMessagesController & {
  steer: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
} {
  return {
    cards,
    queueCapable,
    editCapable: true,
    editor: undefined,
    pause,
    resume: vi.fn(async () => false),
    resuming: false,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    steerNewest: vi.fn(() => false),
    queueResume: undefined,
    queueHold: undefined
  }
}

function waitingDraft(
  messageId: string,
  position: number,
  overrides: Partial<AgentSessionQueuedMessage> = {}
): AgentSessionQueuedMessage {
  return {
    messageId,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `${messageId} text` }] },
    state: 'waiting',
    ...overrides
  }
}

/** The list over the real controller: cards and header as the host's publication projects them.
 *  Nothing runs after a Stop or a /clear. */
function renderHeldQueue(
  queuedMessages: AgentSessionQueuedMessage[],
  queuePause: AgentSessionQueuePause | null
) {
  const mutate = vi.fn(async (..._call: [string, string, Record<string, unknown>]) => null)
  function HeldQueue(): React.JSX.Element {
    const owner = useStructuredAgentSessionQueuedMessages({
      enabled: true,
      queuedMessages,
      queuePause,
      submissions: [],
      hasPendingPrompt: false,
      isWorking: false,
      composerScopeKey: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list only awaits mutate; its answer is never read.
      mutate: mutate as StructuredAgentSessionMutate,
      editTransport: {
        target: { kind: 'local' },
        sessionId: 'session',
        capable: false,
        write: async () => ({ kind: 'dropped' })
      }
    })
    return <NativeChatQueuedMessageList chatWorktreeId={null} controller={owner} />
  }
  const view = render(
    <TooltipProvider delayDuration={0}>
      <HeldQueue />
    </TooltipProvider>
  )
  return { ...view, mutate }
}

beforeEach(() => {
  mocks.updateSettings.mockReset()
})

afterEach(cleanup)

describe('NativeChatQueuedMessageList', () => {
  it.each([
    [
      'Claude',
      "Claude isn't signed in. Run `claude auth login`, or choose an account in Claude Accounts settings."
    ],
    ['Codex', "Codex isn't signed in. Run `codex login`."],
    ['Grok', 'Sign in to Grok with `grok login` on the computer running this chat.'],
    [
      'OpenCode',
      'Sign in to OpenCode with `opencode auth login` on the computer running this chat.'
    ],
    ['Pi', 'Sign in to Pi by running `pi` and using `/login` on the computer running this chat.'],
    ['OMP', 'Sign in to OMP.']
  ])(
    'threads %s identity to returned cards and keeps their Send control',
    (agentName, sentence) => {
      renderList(
        controller([
          card({
            messageId: 'auth',
            state: 'returned',
            hold: 'returned',
            returnedReason: 'Host English',
            returnedRejection: { kind: 'notSignedIn' }
          })
        ]),
        agentName
      )
      expect(screen.getByText(sentence)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
      expect(screen.queryByText(/send your message again/)).toBeNull()
    }
  )

  it.each(['Claude', 'Codex'])(
    'keeps %s managed guidance and shows only delivery when the row explains auth',
    (agentName) => {
      const fact: AgentSessionFailureFact = { kind: 'notSignedIn', account: 'managed' }
      const owner = controller([
        card({ messageId: 'auth', state: 'returned', hold: 'returned', returnedRejection: fact })
      ])
      const rendered = renderList(owner, agentName)
      expect(
        screen.getByText(
          `This ${agentName} account isn't signed in. Sign in again in ${agentName} Accounts settings.`
        )
      ).toBeTruthy()
      rendered.unmount()
      renderList(owner, agentName, [fact])
      expect(screen.getByText('Your message was not sent.')).toBeTruthy()
      expect(screen.queryByText(/account isn't signed in/)).toBeNull()
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    }
  )
  it('renders only an empty live region when the host holds no drafts', () => {
    const { container } = renderList(controller([]))
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('[aria-live="polite"]')?.childElementCount).toBe(0)
  })

  it('the first card appears inside a live region that was already mounted', () => {
    const { container, rerender } = renderList(controller([]))
    const region = container.querySelector('[aria-live="polite"]')
    rerender(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          controller={controller([card({ messageId: 'draft-1' })])}
        />
      </TooltipProvider>
    )
    expect(container.querySelector('[aria-live="polite"]')).toBe(region)
    expect(region?.contains(screen.getByRole('list', { name: 'Queued messages' }))).toBe(true)
  })

  it('is a labeled list with one row per draft, in order', () => {
    renderList(
      controller([
        card({ messageId: 'draft-1', position: 1 }),
        card({ messageId: 'draft-2', position: 2 })
      ])
    )
    screen.getByRole('list', { name: 'Queued messages' })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('text of draft-1')
    expect(rows[1]?.textContent).toContain('text of draft-2')
  })

  it('Steer and Delete are named buttons wired to their card', () => {
    const owner = controller([
      card({ messageId: 'draft-1', position: 1 }),
      card({ messageId: 'draft-2', position: 2 })
    ])
    renderList(owner)
    fireEvent.click(screen.getAllByRole('button', { name: 'Steer' })[0]!)
    expect(owner.steer).toHaveBeenCalledWith('draft-1')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    expect(owner.remove).toHaveBeenCalledWith('draft-2')
  })

  it('a command card never steers: Send only while the agent is idle', () => {
    const owner = controller([
      card({ messageId: 'compact-1', text: '/compact', command: true, waitsForAgent: true }),
      card({ messageId: 'compact-2', text: '/compact', command: true, hold: 'paused' })
    ])
    renderList(owner)
    expect(screen.getAllByText('/compact')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(owner.steer).toHaveBeenCalledWith('compact-2')
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2)
  })

  it('a send on its way reads Sending and offers nothing until the host holds it', () => {
    renderList(controller([card({ messageId: 'sending-1', text: 'on its way', hold: 'sending' })]))
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it("a send-failed command card's caption names Send only when Send is there", () => {
    const failed = { command: true as const, hold: 'paused' as const, pausedReason: 'send_failed' }
    renderList(
      controller([
        card({ messageId: 'working', text: '/compact', ...failed, waitsForAgent: true }),
        card({ messageId: 'idle', text: '/compact', ...failed })
      ])
    )
    expect(
      screen.getByText("Couldn't send — press Send to retry once the agent finishes.")
    ).toBeTruthy()
    expect(screen.getByText("Couldn't send — press Send to retry.")).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(1)
  })

  it('an idle command card waiting its turn reads Send, not Steer', () => {
    renderList(controller([card({ messageId: 'compact-1', text: '/compact', command: true })]))
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull()
  })

  it('a command card offers no Edit: its text is not a draft', async () => {
    renderList(controller([card({ messageId: 'compact-1', text: '/compact', command: true })]))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Turn off queueing' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Edit message' })).toBeNull()
  })

  it("a paused command card's ways out are Delete and the queue's Resume", () => {
    const owner = controller(
      [card({ messageId: 'compact-1', text: '/compact', command: true, hold: 'queue-paused' })],
      { reason: 'stopped' }
    )
    renderList(owner)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(owner.resume).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(owner.remove).toHaveBeenCalledWith('compact-1')
  })

  it("holds every card's Steer while a person's Stop ends the turn; Delete still works", () => {
    const owner = controller([card({ messageId: 'draft-1', position: 1 })])
    render(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList chatWorktreeId={null} controller={owner} steerHeld />
      </TooltipProvider>
    )
    const steer = screen.getByRole('button', { name: 'Steer' })
    expect(steer).toHaveProperty('disabled', true)
    fireEvent.click(steer)
    expect(owner.steer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(owner.remove).toHaveBeenCalledWith('draft-1')
  })

  it.each(['Delete', 'Steer'])(
    '%s hands focus to the composer once the focused card is gone',
    async (name) => {
      const focusComposer = vi.fn()
      const owner = controller([card({ messageId: 'draft-1', position: 1 })])
      render(
        <TooltipProvider delayDuration={0}>
          <NativeChatQueuedMessageList
            chatWorktreeId={null}
            controller={owner}
            focusComposer={focusComposer}
          />
        </TooltipProvider>
      )
      const action = screen.getByRole('button', { name })
      action.focus()
      fireEvent.click(action)
      await waitFor(() => expect(focusComposer).toHaveBeenCalledTimes(1))
    }
  )

  it('a returned card shows the stored reason and offers Send instead of Steer', () => {
    const owner = controller([
      card({
        messageId: 'refused',
        state: 'returned',
        hold: 'returned',
        // Internal marker: never shown verbatim, exactly as for rejected submissions.
        returnedReason: 'host_restarted_before_delivery'
      })
    ])
    renderList(owner)
    expect(screen.getByRole('listitem').textContent).toContain('Your message was not sent.')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(owner.steer).toHaveBeenCalledWith('refused')
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull()
  })

  it('a returned card is worded from its typed fact, exactly as a rejected submission', () => {
    renderList(
      controller([
        card({
          messageId: 'restarted',
          state: 'returned',
          hold: 'returned',
          returnedReason: 'host_restarted_before_delivery',
          returnedRejection: { kind: 'hostRestarted' }
        })
      ])
    )
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Orca restarted before this message was sent.')
    expect(row.textContent).not.toContain('Your message was not sent.')
  })

  it("shows the host's sentence for a fact this build cannot read all of", () => {
    const reason = "Claude couldn't start. Start a new chat to continue."
    renderList(
      controller([
        card({
          messageId: 'newer',
          state: 'returned',
          hold: 'returned',
          returnedReason: reason,
          // As a newer host sends it: a known code with a reason this build doesn't know.
          returnedRejection: JSON.parse(
            '{ "kind": "startFailed", "refusal": { "code": "agent_session_conflict", "details": { "reason": "newerReason" } } }'
          )
        })
      ])
    )
    expect(screen.getByRole('listitem').textContent).toContain(reason)
  })

  it('the words leave out sending again: the card offers its own Send', () => {
    renderList(
      controller([
        card({
          messageId: 'undelivered',
          state: 'returned',
          hold: 'returned',
          returnedReason: 'not_delivered',
          returnedRejection: { kind: 'notDelivered' }
        })
      ])
    )
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('This message was not delivered.')
    expect(row.textContent).not.toContain('Send it again')
  })

  it("a Stop's withdrawal is read from the fact, whatever sentence the reason carries", () => {
    renderList(
      controller([
        card({
          messageId: 'stopped',
          state: 'returned',
          hold: 'returned',
          returnedReason: 'This message was withdrawn before the agent started it.',
          returnedRejection: { kind: 'cancelled' }
        })
      ])
    )
    expect(screen.getByRole('listitem').textContent).toContain('Stopped before it was sent')
  })

  it("a provider's own refusal words are shown verbatim", () => {
    renderList(
      controller([
        card({
          messageId: 'refused',
          state: 'returned',
          hold: 'returned',
          returnedReason: 'The active turn cannot be steered during review.'
        })
      ])
    )
    expect(screen.getByRole('listitem').textContent).toContain(
      'The active turn cannot be steered during review.'
    )
  })

  it.each([
    ['stopped', 'Queue paused because you interrupted'],
    ['some-newer-reason', 'Queue paused']
  ])(
    "a queue the host holds ('%s') shows one header row above the cards, with Resume; the held card still reads Steer",
    (reason, text) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a newer host may publish a reason this client's type does not list.
      const pause = { reason } as AgentSessionQueuePause
      const { container, mutate } = renderHeldQueue([waitingDraft('held', 1)], pause)
      expect(container.textContent).toContain(text)
      const list = screen.getByRole('list')
      // The row sits above the list, not inside it: it is not a queued message.
      expect(within(list).queryByText(text)).toBeNull()
      const row = within(list).getByRole('listitem')
      // The text is the card's only line: the header carries the why.
      expect(row.querySelectorAll('p')).toHaveLength(1)
      expect(within(row).queryByRole('button', { name: 'Send' })).toBeNull()
      expect(within(row).getByRole('button', { name: 'Steer' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
      expect(mutate).toHaveBeenCalledWith(
        'agentSession.queuedMessagesResume',
        'agentSession.queuedMessagesResume',
        {}
      )
    }
  )

  it('a paused queue holds every card, in order, under one header', () => {
    renderHeldQueue([waitingDraft('a', 1), waitingDraft('b', 2)], { reason: 'stopped' })
    expect(screen.getByText('Queue paused because you interrupted')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Steer' })).toHaveLength(2)
  })

  it('no header row when the queue drains on its own (or after a restart), or with no cards', () => {
    renderHeldQueue([waitingDraft('waiting', 1)], null)
    expect(screen.queryByText(/Queue paused/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    cleanup()
    const { container } = renderHeldQueue([], { reason: 'stopped' })
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('no header row over cards Resume would not send: returned, held on their own, or behind', () => {
    const stopped = { reason: 'stopped' } as const
    const { container } = renderHeldQueue(
      [
        waitingDraft('refused', 1, { state: 'returned', returnedReason: null }),
        waitingDraft('behind', 2),
        waitingDraft('failed', 3, { paused: true, pausedReason: 'send_failed' })
      ],
      stopped
    )
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(container.textContent).not.toContain('Queue paused')
  })

  it('Resume shows it is pending, keeps the full text for a truncated line, and hands focus back', async () => {
    const focusComposer = vi.fn()
    const owner = {
      ...controller([card({ messageId: 'waiting', hold: 'queue-paused' })], { reason: 'stopped' }),
      resuming: true
    }
    render(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          controller={owner}
          focusComposer={focusComposer}
        />
      </TooltipProvider>
    )
    const resume = screen.getByRole('button', { name: 'Resume' })
    expect(resume).toHaveProperty('disabled', true)
    expect(screen.getByTitle('Queue paused because you interrupted')).toBeTruthy()
    cleanup()
    const idle = controller([card({ messageId: 'waiting', hold: 'queue-paused' })], {
      reason: 'stopped'
    })
    render(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          controller={idle}
          focusComposer={focusComposer}
        />
      </TooltipProvider>
    )
    const enabled = screen.getByRole('button', { name: 'Resume' })
    enabled.focus()
    fireEvent.click(enabled)
    expect(idle.resume).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(focusComposer).toHaveBeenCalledTimes(1))
  })

  it('Steer carries the ↳ icon; a card leads with the queue glyph, a failed one with the alert', () => {
    const { container } = renderList(
      controller([
        card({ messageId: 'waiting' }),
        card({ messageId: 'failed', hold: 'paused', pausedReason: 'send_failed', position: 2 })
      ])
    )
    const [waiting, failed] = screen.getAllByRole('listitem')
    expect(
      within(waiting!)
        .getByRole('button', { name: 'Steer' })
        .querySelector('.lucide-corner-down-right')
    ).not.toBeNull()
    // The card's row (its first child) leads with the glyph.
    expect(
      waiting!.firstElementChild?.firstElementChild?.classList.contains('lucide-list-end')
    ).toBe(true)
    expect(
      within(failed!).getByRole('button', { name: 'Send' }).querySelector('.lucide-send')
    ).not.toBeNull()
    expect(
      failed!.firstElementChild?.firstElementChild?.classList.contains('lucide-circle-alert')
    ).toBe(true)
    expect(container.querySelectorAll('.lucide-list-end')).toHaveLength(1)
  })

  it('one bordered box holds the pause row and every card, rows divided, cards unbordered', () => {
    renderList(
      controller(
        [
          card({ messageId: 'waiting', hold: 'queue-paused' }),
          card({ messageId: 'refused', state: 'returned', hold: 'returned', position: 2 }),
          card({ messageId: 'failed', hold: 'paused', pausedReason: 'send_failed', position: 3 })
        ],
        { reason: 'stopped' }
      )
    )
    const list = screen.getByRole('list')
    const box = list.parentElement!
    expect(box.className.split(' ')).toEqual(
      expect.arrayContaining(['rounded-md', 'border', 'border-border', 'bg-card', 'divide-y'])
    )
    // The pause row is the box's first row, outside the list; the list is its second.
    expect(box.children).toHaveLength(2)
    expect(box.firstElementChild?.textContent).toContain('Queue paused because you interrupted')
    expect(box.lastElementChild).toBe(list)
    expect(list.className.split(' ')).toContain('divide-y')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.className.split(' ')).not.toContain('border')
      expect(row.className.split(' ')).not.toContain('rounded-md')
    }
    // Captions still render on their own rows.
    expect(rows[2]?.textContent).toContain("Couldn't send — press Send to retry.")
  })

  it('without a pause the box holds only the list, one card or many', () => {
    for (const count of [1, 4]) {
      const view = renderList(
        controller(
          Array.from({ length: count }, (_, index) =>
            card({ messageId: `draft-${index}`, position: index })
          )
        )
      )
      const list = screen.getByRole('list')
      expect(list.parentElement?.children).toHaveLength(1)
      expect(within(list).getAllByRole('listitem')).toHaveLength(count)
      view.unmount()
    }
  })

  it('the Steer tooltip spaces its hint from the shortcut chips', async () => {
    renderList(controller([card({ messageId: 'newest' })]))
    fireEvent.focus(screen.getByRole('button', { name: 'Steer' }))
    const hint = await screen.findAllByText('Submit without interrupting the model')
    const group = hint[0]!.parentElement!
    expect(group.tagName).toBe('SPAN')
    expect(group.className).toBe('flex items-center gap-2')
    expect(group.children).toHaveLength(2)
  })

  it('cards keep Steer, Delete and More actions while the queue is paused', () => {
    const owner = controller([card({ messageId: 'waiting', hold: 'queue-paused' })], {
      reason: 'stopped'
    })
    renderList(owner)
    const row = screen.getByRole('listitem')
    expect(within(row).getByRole('button', { name: 'Steer' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'More actions' })).toBeTruthy()
    expect(row.querySelectorAll('p')).toHaveLength(1)
    fireEvent.click(within(row).getByRole('button', { name: 'Steer' }))
    expect(owner.steer).toHaveBeenCalledWith('waiting')
  })

  it('every card still waiting on the queue reads Steer; one held on its own or returned, Send', () => {
    for (const hold of ['turn', 'awaiting-answer', 'behind-returned', 'queue-paused'] as const) {
      expect(queuedMessageCardSendNow(card({ messageId: hold, hold }))).toEqual({
        steers: true,
        label: 'Steer',
        hint: 'Submit without interrupting the model'
      })
    }
    for (const hold of ['paused', 'returned'] as const) {
      expect(queuedMessageCardSendNow(card({ messageId: hold, hold }))).toEqual({
        steers: false,
        label: 'Send',
        hint: 'Send this message now'
      })
    }
  })

  it("the host's pause and withdrawal markers localize instead of rendering raw", () => {
    renderList(
      controller([
        card({
          messageId: 'failed-consume',
          hold: 'paused',
          pausedReason: 'send_failed'
        }),
        card({
          messageId: 'stopped',
          state: 'returned',
          hold: 'returned',
          position: 2,
          // A cancellation confirmed after Stop settled renders as an ordinary card.
          returnedReason: 'provider_cancelled_before_start'
        })
      ])
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain("Couldn't send — press Send to retry.")
    expect(rows[0]?.textContent).not.toContain('send_failed')
    expect(rows[1]?.textContent).toContain('Stopped before it was sent')
    // Still a normal returned card: Send and Delete stay offered.
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBeGreaterThan(0)
  })

  it('an absent or unknown pause marker reads as a plain pause, never raw', () => {
    renderList(
      controller([
        card({ messageId: 'future', hold: 'paused', pausedReason: 'some_newer_marker' }),
        card({ messageId: 'bare', hold: 'paused', position: 2 })
      ])
    )
    for (const row of screen.getAllByRole('listitem')) {
      expect(row.querySelectorAll('p')[1]?.textContent).toBe('Paused')
    }
    expect(screen.getAllByRole('listitem')[0]?.textContent).not.toContain('some_newer_marker')
  })

  it('a draft behind a returned card says a message ahead needs attention', () => {
    renderList(controller([card({ messageId: 'behind', hold: 'behind-returned' })]))
    expect(screen.getByRole('listitem').textContent).toContain(
      'Waiting — a message ahead needs attention'
    )
  })

  it('a clipped card opens to its whole text, line breaks kept, and folds back', () => {
    // happy-dom lays nothing out: a line wider than its box is what a clipped card measures.
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900)
    const box = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    try {
      const text = 'You have 1 orchestration message.\nRun `orca orchestration check --run run_e99`'
      renderList(controller([card({ messageId: 'mail', text })]))
      const open = screen.getByRole('button', { name: 'Show full message' })
      expect(open.getAttribute('aria-expanded')).toBe('false')
      // A native button in the tab order: Enter or Space opens it from the keyboard.
      expect(open.tagName).toBe('BUTTON')
      expect(open.getAttribute('tabindex')).not.toBe('-1')
      open.focus()
      expect(document.activeElement).toBe(open)
      fireEvent.click(open)
      const fold = screen.getByRole('button', { name: 'Show less' })
      expect(fold.getAttribute('aria-expanded')).toBe('true')
      const whole = document.getElementById(fold.getAttribute('aria-controls') ?? '')
      expect(whole?.textContent).toBe(text)
      expect(whole?.className).toContain('whitespace-pre-wrap')
      expect(whole?.className).not.toContain('truncate')
      // Opened below the row, at the card's width, not squeezed beside its actions.
      expect(whole?.parentElement?.tagName).toBe('LI')
      fireEvent.click(fold)
      expect(screen.getByRole('button', { name: 'Show full message' })).toBeTruthy()
    } finally {
      width.mockRestore()
      box.mockRestore()
    }
  })

  it('a card whose text fits its line offers no toggle', () => {
    renderList(controller([card({ messageId: 'short', text: 'ok' })]))
    expect(screen.queryByRole('button', { name: 'Show full message' })).toBeNull()
  })

  it('the menu offers Edit message and Turn off queueing', async () => {
    const owner = controller([card({ messageId: 'draft-1' })])
    renderList(owner)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    expect(owner.edit).toHaveBeenCalledWith('draft-1')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Turn off queueing' }))
    expect(mocks.updateSettings).toHaveBeenCalledWith({ nativeChatQueueFollowUps: false })
  })

  // A kept message shows as a card even where the host does not queue sends; there the setting
  // and the chord would do nothing, so neither is offered.
  it.each([
    { queueCapable: true, offered: true },
    { queueCapable: false, offered: false }
  ])(
    'offers Turn off queueing and the send chord only when the host queues sends ($queueCapable)',
    async ({ queueCapable, offered }) => {
      const owner = controller([card({ messageId: 'kept', hold: 'paused' })], null, queueCapable)
      renderList(owner)
      fireEvent.focus(screen.getByRole('button', { name: 'Send' }))
      const hint = await screen.findAllByText('Send this message now')
      expect(hint[0]!.parentElement!.children).toHaveLength(offered ? 2 : 1)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
      expect(await screen.findByRole('menuitem', { name: 'Edit message' })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: 'Turn off queueing' }) !== null).toBe(offered)
      // Send, Delete and Edit work either way.
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      expect(owner.edit).toHaveBeenCalledWith('kept')
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      expect(owner.steer).toHaveBeenCalledWith('kept')
    }
  )

  // A long queue scrolls inside its own bounded box; a card the person queues is scrolled to,
  // while another agent's card leaves the view on the next card to send.
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

  // The queue a chat opens with arrives after the list mounts; it opens on the next card to send.
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
})
