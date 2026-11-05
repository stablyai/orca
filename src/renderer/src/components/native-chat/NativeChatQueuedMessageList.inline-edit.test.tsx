// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
import type { QueuedMessageCard } from '../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

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
