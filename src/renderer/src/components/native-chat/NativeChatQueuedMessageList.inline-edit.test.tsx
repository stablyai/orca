// @vitest-environment happy-dom

// A card edited in place inside the list: the editor replaces its text and actions, a host that
// cannot edit offers no Edit, and focus leaves a closing editor for the question or the composer.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
// A card's sender line opens and names agents through modules this test does not exercise.
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: vi.fn()
}))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))
vi.mock('../../store', () => {
  const state = { updateSettings: vi.fn() }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

function renderList(owner: StructuredAgentSessionQueuedMessagesController) {
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatQueuedMessageList chatWorktreeId={null} controller={owner} />
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
  pause: { reason: string } | null,
  queueCapable: boolean,
  edits: Pick<StructuredAgentSessionQueuedMessagesController, 'editCapable' | 'editor'>
): StructuredAgentSessionQueuedMessagesController {
  return {
    cards,
    queueCapable,
    ...edits,
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

afterEach(() => cleanup())

describe('NativeChatQueuedMessageList inline edit', () => {
  it('a host that cannot edit in place offers no Edit, and an empty menu is not shown', async () => {
    const owner = controller([card({ messageId: 'kept', hold: 'paused' })], null, false, {
      editCapable: false,
      editor: undefined
    })
    renderList(owner)
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('the card being edited shows its editor in place of its text and actions; others cannot open one', async () => {
    const editor = {
      messageId: 'draft-1',
      text: 'editing',
      acquiring: false,
      saving: false,
      canSave: true,
      change: vi.fn(),
      save: vi.fn(),
      cancel: vi.fn()
    }
    const owner = controller(
      [card({ messageId: 'draft-1' }), card({ messageId: 'draft-2', position: 2 })],
      null,
      true,
      { editCapable: true, editor }
    )
    renderList(owner)
    const [edited, other] = screen.getAllByRole('listitem')
    expect(within(edited!).getByRole('textbox', { name: 'Edit message' })).toBeTruthy()
    expect(within(edited!).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(within(edited!).queryByText('text of draft-1')).toBeNull()
    fireEvent.pointerDown(within(other!).getByRole('button', { name: 'More actions' }))
    const item = await screen.findByRole('menuitem', { name: 'Edit message' })
    expect(item.getAttribute('aria-disabled')).toBe('true')
  })

  it('an edited card shows the editing header with its sender and hides its caption until editing ends', () => {
    const editor = {
      messageId: 'mail',
      text: 'editing',
      acquiring: false,
      saving: false,
      canSave: true,
      change: vi.fn(),
      save: vi.fn(),
      cancel: vi.fn()
    }
    const cards = [
      card({
        messageId: 'mail',
        hold: 'awaiting-answer',
        from: { kind: 'agent', senders: [], orchestration: null }
      })
    ]
    const { rerender } = renderList(controller(cards, null, true, { editCapable: true, editor }))
    const row = screen.getByRole('listitem')
    expect(within(row).getByText('Editing message')).toBeTruthy()
    expect(within(row).getByText('From')).toBeTruthy()
    expect(within(row).queryByText('Waiting for your answer')).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel editing' }))
    expect(editor.cancel).toHaveBeenCalledOnce()
    rerender(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          controller={controller(cards, null, true, {
            editCapable: true,
            editor: undefined
          })}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Waiting for your answer')).toBeTruthy()
    expect(screen.queryByText('Editing message')).toBeNull()
  })

  it.each([
    { prompt: true, expected: 'the question' },
    { prompt: false, expected: 'the composer' }
  ])('a closing edit hands focus to $expected', async ({ prompt }) => {
    const focusComposer = vi.fn()
    const editor = {
      messageId: 'draft-1',
      text: 'editing',
      acquiring: false,
      saving: false,
      canSave: true,
      change: vi.fn(),
      save: vi.fn(),
      cancel: vi.fn()
    }
    const cards = [card({ messageId: 'draft-1' })]
    const pane = (owner: ReturnType<typeof controller>) => (
      <div data-native-chat-root="true">
        <TooltipProvider delayDuration={0}>
          <NativeChatQueuedMessageList
            chatWorktreeId={null}
            controller={owner}
            focusComposer={focusComposer}
          />
        </TooltipProvider>
        {/* The composer's slot, held by a question that wants focus. */}
        {prompt ? <div tabIndex={-1} data-native-chat-prompt-card-focus="" /> : null}
      </div>
    )
    const { container, rerender } = render(
      pane(controller(cards, null, true, { editCapable: true, editor }))
    )
    screen.getByRole('textbox', { name: 'Edit message' }).focus()
    rerender(pane(controller(cards, null, true, { editCapable: true, editor: undefined })))
    const question = container.querySelector<HTMLElement>('[data-native-chat-prompt-card-focus]')
    if (prompt) {
      await waitFor(() => expect(document.activeElement).toBe(question))
      expect(focusComposer).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(focusComposer).toHaveBeenCalledOnce())
    }
  })
})
