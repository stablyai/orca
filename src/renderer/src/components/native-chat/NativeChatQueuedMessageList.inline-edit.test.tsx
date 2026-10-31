// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatComposerProps } from './native-chat-composer-types'
import type { QueuedEditAttachTarget } from './NativeChatQueuedMessageComposer'

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

vi.mock('./NativeChatComposer', async () => {
  const React = await import('react')
  return {
    NativeChatComposer: React.forwardRef<HTMLTextAreaElement, NativeChatComposerProps>(
      (props, ref) => (
        <>
          <textarea ref={ref} aria-label="Edit message" />
          <button onClick={props.editSession?.cancel}>Cancel editing</button>
        </>
      )
    )
  }
})

const editAttachTo: QueuedEditAttachTarget = {
  terminalTabId: 'tab',
  transport: {
    capturePresentation: () => () => true,
    send: () => false,
    dispatchCommand: async () => {
      throw new Error('not used by the queue renderer')
    },
    optionsSurface: {
      getSnapshot: () => [],
      setOption: async () => {
        throw new Error('not used')
      },
      invokeAction: async () => {
        throw new Error('not used')
      },
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session',
    runtimeEnvironmentId: null
  }
}

import { TooltipProvider } from '@/components/ui/tooltip'
import type { QueuedMessageCard } from '../../../../shared/structured-agent-session-queued-cards'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

function renderList(owner: StructuredAgentSessionQueuedMessagesController) {
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatQueuedMessageList
        chatWorktreeId={null}
        controller={owner}
        editAttachTo={editAttachTo}
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
  pause: { reason: string } | null,
  queueCapable: boolean,
  edits: Pick<StructuredAgentSessionQueuedMessagesController, 'editCapable' | 'editor'>
): StructuredAgentSessionQueuedMessagesController {
  return {
    cards,
    queueCapable,
    clearCapable: true,
    ...edits,
    pause,
    resume: vi.fn(async () => false),
    clear: vi.fn(async () => true),
    queuePending: null,
    pending: () => null,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    steerHead: vi.fn(() => false),
    isWorking: true
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('NativeChatQueuedMessageList inline edit', () => {
  it('reorders only user cards from the grip with arrow keys and retains focus', async () => {
    const cards = [card({ messageId: 'a' }), card({ messageId: 'b', position: 2 })]
    const owner = controller(cards, null, true, { editCapable: true, editor: undefined })
    const move = vi.fn(async () => {})
    owner.reorder = { scope: 'session', pending: false, move }
    const view = renderList(owner)
    const grip = screen.getAllByRole('button', { name: 'Reorder message' })[0]!
    grip.focus()
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(move).toHaveBeenCalledExactlyOnceWith('a', { afterMessageId: 'b' })
    view.rerender(
      <TooltipProvider>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          controller={{ ...owner, cards: [cards[1]!, cards[0]!] }}
        />
      </TooltipProvider>
    )
    expect(document.activeElement).toBe(grip)
  })

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
      draftScopeKey: 'edit-scope',
      imagesCapable: true,
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
    owner.reorder = { scope: 'session', pending: false, move: vi.fn(async () => {}) }
    renderList(owner)
    expect(screen.queryByRole('button', { name: 'Reorder message' })).toBeNull()
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
      draftScopeKey: 'edit-scope',
      imagesCapable: true,
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
        hold: 'behind-returned',
        from: { kind: 'agent', senders: [], orchestration: null }
      })
    ]
    const { rerender } = renderList(controller(cards, null, true, { editCapable: true, editor }))
    const row = screen.getByRole('listitem')
    expect(within(row).getByText('Editing message')).toBeTruthy()
    expect(within(row).getByText('From')).toBeTruthy()
    expect(within(row).queryByText('Waiting — a message ahead needs attention')).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel editing' }))
    expect(editor.cancel).toHaveBeenCalledOnce()
    rerender(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList
          chatWorktreeId={null}
          editAttachTo={editAttachTo}
          controller={controller(cards, null, true, {
            editCapable: true,
            editor: undefined
          })}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Waiting — a message ahead needs attention')).toBeTruthy()
    expect(screen.queryByText('Editing message')).toBeNull()
  })

  it.each([
    { prompt: true, expected: 'the question' },
    { prompt: false, expected: 'the composer' }
  ])('a closing edit hands focus to $expected', async ({ prompt }) => {
    const focusComposer = vi.fn()
    const editor = {
      messageId: 'draft-1',
      draftScopeKey: 'edit-scope',
      imagesCapable: true,
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
            editAttachTo={editAttachTo}
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

// The active production row owns exactly two observations, independent of queue size.
it.each([10, 100])(
  'reveals active editor/footer on size changes with %i cards and releases ownership',
  (count) => {
    const observers: {
      callback: () => void
      observe: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(readonly callback: () => void) {
          observers.push(this)
        }
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    let height = 200,
      viewport = 288
    const original = HTMLElement.prototype.getBoundingClientRect
    const measured = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'UL') {
          return DOMRect.fromRect({ y: 100, height: viewport })
        }
        if (this.hasAttribute('data-queued-message-editor')) {
          return DOMRect.fromRect({ y: 150 - (this.closest('ul')?.scrollTop ?? 0), height })
        }
        return original.call(this)
      })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.tagName === 'UL' ? viewport : 0
    })
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    const editor = {
      messageId: 'active',
      draftScopeKey: 'scope',
      text: 'edit',
      imagesCapable: true,
      acquiring: false,
      saving: false,
      canSave: true,
      change: vi.fn(),
      save: vi.fn(),
      cancel: vi.fn()
    }
    const cards = [
      card({ messageId: 'active' }),
      ...Array.from({ length: count - 1 }, (_, i) => card({ messageId: `other-${i}` }))
    ]
    const view = renderList(controller(cards, null, true, { editCapable: true, editor }))
    const scrollport = screen.getByRole('list', { name: 'Queued messages' })
    const observer = observers.find((entry) =>
      entry.observe.mock.calls.some(([node]) => node === scrollport)
    )!
    const resize = observer.callback
    expect(observer.observe.mock.calls.map(([node]) => node)).toEqual([
      view.container.querySelector('[data-queued-message-editor]'),
      scrollport
    ])
    expect(scrollport.scrollTop).toBe(0)
    // Notice/image/text growth: oversized editor exposes its trailing actions.
    height = 323
    resize()
    expect(scrollport.scrollTop).toBe(85)
    expect(focus).toHaveBeenCalledOnce()
    const beforeManual = measured.mock.calls.length
    scrollport.scrollTop = 0
    fireEvent.scroll(scrollport)
    expect(measured.mock.calls.length).toBe(beforeManual)
    expect(scrollport.scrollTop).toBe(0)
    viewport = 180
    resize()
    expect(scrollport.scrollTop).toBe(193)
    // Shrink back to a fitting row: minimally reveal its top, within the queue only.
    height = 100
    resize()
    expect(scrollport.scrollTop).toBe(50)
    expect(view.container.scrollTop).toBe(0)
    expect(focus).toHaveBeenCalledOnce()
    view.unmount()
    expect(observer.disconnect).toHaveBeenCalledOnce()
  }
)
