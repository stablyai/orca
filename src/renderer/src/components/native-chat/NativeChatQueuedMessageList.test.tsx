// @vitest-environment happy-dom

// The card stack above the composer: an accessible, labeled live list whose
// rows expose Steer/Send, Delete, and the Edit / Turn-off-queueing menu, with
// captions derived client-side per state.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
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
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

function renderList(owner: StructuredAgentSessionQueuedMessagesController) {
  // The app root mounts the provider; tests supply the same context.
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatQueuedMessageList controller={owner} />
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
    pause,
    resume: vi.fn(async () => {}),
    resuming: false,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    steerNewest: vi.fn(() => false)
  }
}

beforeEach(() => {
  mocks.updateSettings.mockReset()
})

afterEach(cleanup)

describe('NativeChatQueuedMessageList', () => {
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
        <NativeChatQueuedMessageList controller={controller([card({ messageId: 'draft-1' })])} />
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

  it("holds every card's Steer while a person's Stop ends the turn; Delete still works", () => {
    const owner = controller([card({ messageId: 'draft-1', position: 1 })])
    render(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList controller={owner} steerHeld />
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
          <NativeChatQueuedMessageList controller={owner} focusComposer={focusComposer} />
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

  it('a paused queue shows one header row per reason above the cards, with Resume', () => {
    const cases = [
      ['stopped', 'Queue paused because you interrupted'],
      ['restarted', 'Queue paused because Orca restarted'],
      ['cleared', 'Queue paused after you cleared the conversation'],
      ['some-newer-reason', 'Queue paused']
    ] as const
    for (const [reason, text] of cases) {
      const owner = controller([card({ messageId: 'waiting', hold: 'queue-paused' })], { reason })
      const view = renderList(owner)
      expect(view.container.textContent).toContain(text)
      // The row sits above the list, not inside it: it is not a queued message.
      expect(within(screen.getByRole('list')).queryByText(text)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
      expect(owner.resume).toHaveBeenCalledTimes(1)
      view.unmount()
    }
  })

  it('no header row when the queue drains on its own, or when there are no cards', () => {
    renderList(controller([card({ messageId: 'waiting' })], null))
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    cleanup()
    const { container } = renderList(controller([], { reason: 'stopped' }))
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('no header row over cards Resume would not send: returned, held on their own, or behind', () => {
    renderList(
      controller(
        [
          card({ messageId: 'refused', state: 'returned', hold: 'returned', returnedReason: null }),
          card({ messageId: 'behind', hold: 'behind-returned', position: 2 }),
          card({ messageId: 'failed', hold: 'paused', pausedReason: 'send_failed', position: 3 })
        ],
        { reason: 'stopped' }
      )
    )
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('Resume shows it is pending, keeps the full text for a truncated line, and hands focus back', async () => {
    const focusComposer = vi.fn()
    const owner = {
      ...controller([card({ messageId: 'waiting', hold: 'queue-paused' })], { reason: 'stopped' }),
      resuming: true
    }
    render(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList controller={owner} focusComposer={focusComposer} />
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
        <NativeChatQueuedMessageList controller={idle} focusComposer={focusComposer} />
      </TooltipProvider>
    )
    const enabled = screen.getByRole('button', { name: 'Resume' })
    enabled.focus()
    fireEvent.click(enabled)
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
    expect(waiting!.firstElementChild?.classList.contains('lucide-list-end')).toBe(true)
    expect(
      within(failed!).getByRole('button', { name: 'Send' }).querySelector('.lucide-send')
    ).not.toBeNull()
    expect(failed!.firstElementChild?.classList.contains('lucide-circle-alert')).toBe(true)
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

  it('only a card still waiting on the turn promises to skip the wait', () => {
    for (const hold of ['turn', 'awaiting-answer', 'behind-returned'] as const) {
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

  // A message the host kept after a restart or a close is not a mid-turn steer: on an idle chat
  // its action is plainly Send, and its caption says it was never sent.
  it('a kept card says it was not sent yet and offers Send, with no Resume over it', async () => {
    renderList(
      controller([card({ messageId: 'held', hold: 'paused', pausedReason: 'kept' })], {
        reason: 'restarted'
      })
    )
    const [row] = screen.getAllByRole('listitem')
    expect(row?.textContent).toContain('Not sent yet — press Send to send it.')
    expect(row?.textContent).not.toContain('kept')
    fireEvent.focus(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findAllByText('Send this message now')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
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
      const owner = controller(
        [card({ messageId: 'kept', hold: 'paused', pausedReason: 'kept' })],
        null,
        queueCapable
      )
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
})
