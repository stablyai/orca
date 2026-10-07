import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support'
// @vitest-environment happy-dom

// A message sent while the queue is held asks first, from Enter and from the button alike:
// Clear queue deletes every card and then sends, Send message sends and keeps them, and
// dismissing sends nothing and leaves the draft where it was.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as nativeChatAgentProfiles from '../../../../shared/native-chat-agent-profiles'
import type {
  NativeChatQueueHold,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { count?: number }) =>
    fallback.replace('{{count}}', String(options?.count ?? ''))
}))
// The button's own wiring: the primary action calls the same `send` Enter does.
vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: ({ onSend }: { onSend: () => void }) => (
    <button type="button" data-testid="composer-send" onClick={onSend}>
      Send
    </button>
  )
}))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('./claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: vi.fn()
}))
vi.mock('../../../../shared/native-chat-agent-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof nativeChatAgentProfiles>()),
  getVerifiedNativeChatCommands: () => []
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))

import { NativeChatComposer } from './NativeChatComposer'

const PASS_THROUGH = { handled: false, accepted: false, error: null }

function transport(queueHold?: NativeChatQueueHold): NativeChatStructuredComposerTransport {
  return {
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => PASS_THROUGH),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-test',
    runtimeEnvironmentId: null,
    ...(queueHold ? { queueHold } : {})
  }
}

function heldQueue(
  count: number,
  cleared = true
): NativeChatQueueHold & {
  clear: ReturnType<typeof vi.fn>
} {
  return { count, clear: vi.fn(async () => cleared) }
}

let paneCounter = 0

function renderComposer(structuredTransport: NativeChatStructuredComposerTransport) {
  paneCounter += 1
  render(
    <NativeChatComposer
      terminalTabId={`tab-${paneCounter}`}
      paneKey={`tab-${paneCounter}:structured`}
      targetPtyId={null}
      agent="codex"
      structuredTransport={structuredTransport}
    />
  )
  return screen.getByRole('textbox')
}

function pressEnter(input: HTMLElement): void {
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })
}

const BODY =
  'You are about to send a message. Do you want to clear the 2 messages previously queued?'

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      git: { discoverCommitMessageModels: vi.fn().mockResolvedValue({ success: false }) },
      pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) },
      ui: { onFileDrop: () => vi.fn() }
    }
  })
})

afterEach(() => cleanup())

describe('sending while the queue is held', () => {
  it('Enter and the send button both ask first, and nothing is sent until the person chooses', async () => {
    for (const submit of [pressEnter, () => fireEvent.click(screen.getByTestId('composer-send'))]) {
      const structured = transport(heldQueue(2))
      const input = renderComposer(structured)
      changePrompt(input, 'a new instruction')
      await act(async () => submit(input))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toContain('Send message?')
      expect(dialog.textContent).toContain(BODY)
      expect(screen.getByRole('button', { name: 'Clear queue' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy()
      expect(structured.dispatchCommand).not.toHaveBeenCalled()
      expect(structured.send).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it('Send message sends the draft and keeps the cards', async () => {
    const hold = heldQueue(2)
    const structured = transport(hold)
    const input = renderComposer(structured)
    changePrompt(input, 'a new instruction')
    await act(async () => pressEnter(input))
    await act(async () =>
      fireEvent.click(await screen.findByRole('button', { name: 'Send message' }))
    )
    await waitFor(() => expect(structured.send).toHaveBeenCalledWith('a new instruction', []))
    expect(hold.clear).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Clear queue deletes every card first, then sends', async () => {
    const deleted = Promise.withResolvers<boolean>()
    const hold = heldQueue(2)
    hold.clear.mockReturnValue(deleted.promise)
    const structured = transport(hold)
    const input = renderComposer(structured)
    changePrompt(input, 'start over')
    await act(async () => pressEnter(input))
    await act(async () =>
      fireEvent.click(await screen.findByRole('button', { name: 'Clear queue' }))
    )
    expect(hold.clear).toHaveBeenCalledTimes(1)
    // Nothing goes out while the deletes are on their way.
    await act(async () => {})
    expect(structured.dispatchCommand).not.toHaveBeenCalled()
    expect(structured.send).not.toHaveBeenCalled()
    await act(async () => deleted.resolve(true))
    await waitFor(() => expect(structured.send).toHaveBeenCalledWith('start over', []))
  })

  it('a Clear queue whose delete fails sends nothing and keeps the draft', async () => {
    const hold = heldQueue(2, false)
    const structured = transport(hold)
    const input = renderComposer(structured)
    changePrompt(input, 'start over')
    await act(async () => pressEnter(input))
    await act(async () =>
      fireEvent.click(await screen.findByRole('button', { name: 'Clear queue' }))
    )
    await waitFor(() => expect(hold.clear).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(structured.dispatchCommand).not.toHaveBeenCalled()
    expect(structured.send).not.toHaveBeenCalled()
    expect(promptValue(input)).toBe('start over')
  })

  it('dismissing sends nothing, keeps the draft and returns focus to the composer', async () => {
    const hold = heldQueue(2)
    const structured = transport(hold)
    const input = renderComposer(structured)
    changePrompt(input, 'not yet')
    await act(async () => pressEnter(input))
    const dialog = await screen.findByRole('dialog')
    await act(async () => fireEvent.keyDown(dialog, { key: 'Escape' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(structured.send).not.toHaveBeenCalled()
    expect(hold.clear).not.toHaveBeenCalled()
    expect(promptValue(input)).toBe('not yet')
    await waitFor(() => expect(input.contains(document.activeElement)).toBe(true))
  })

  describe('a choice is taken once', () => {
    /** The primitive's exit animation, which keeps the closing dialog mounted and clickable. */
    function withExitAnimation(): () => void {
      const style = document.createElement('style')
      style.textContent =
        '[role="dialog"][data-state="closed"] { animation-name: exit; animation-duration: 200ms; }'
      document.head.appendChild(style)
      return () => style.remove()
    }

    it('Send message pressed again while the dialog closes sends nothing more', async () => {
      const removeAnimation = withExitAnimation()
      try {
        const structured = transport(heldQueue(1))
        const input = renderComposer(structured)
        changePrompt(input, 'once only')
        await act(async () => pressEnter(input))
        const sendButton = await screen.findByRole('button', { name: 'Send message' })
        await act(async () => fireEvent.click(sendButton))
        expect(document.body.contains(sendButton)).toBe(true)
        await act(async () => fireEvent.click(sendButton))
        await act(async () => {})
        expect(structured.send).toHaveBeenCalledTimes(1)
      } finally {
        removeAnimation()
      }
    })

    it('a double-click, or a held Enter, before any re-render sends once', async () => {
      const structured = transport(heldQueue(1))
      const input = renderComposer(structured)
      changePrompt(input, 'once only')
      await act(async () => pressEnter(input))
      const sendButton = await screen.findByRole('button', { name: 'Send message' })
      await act(async () => {
        sendButton.click()
        sendButton.click()
      })
      await act(async () => {})
      expect(structured.send).toHaveBeenCalledTimes(1)
    })

    it('Clear queue pressed twice clears once and sends once', async () => {
      const removeAnimation = withExitAnimation()
      try {
        const hold = heldQueue(2)
        const structured = transport(hold)
        const input = renderComposer(structured)
        changePrompt(input, 'start over')
        await act(async () => pressEnter(input))
        const clearButton = await screen.findByRole('button', { name: 'Clear queue' })
        await act(async () => {
          clearButton.click()
          clearButton.click()
        })
        await act(async () => fireEvent.click(clearButton))
        await waitFor(() => expect(structured.send).toHaveBeenCalledTimes(1))
        await act(async () => {})
        expect(hold.clear).toHaveBeenCalledTimes(1)
        expect(structured.send).toHaveBeenCalledTimes(1)
      } finally {
        removeAnimation()
      }
    })
  })

  describe("while Clear queue's deletes run", () => {
    async function clearingQueue(text: string) {
      const deleted = Promise.withResolvers<boolean>()
      const hold = heldQueue(2)
      hold.clear.mockReturnValue(deleted.promise)
      const structured = transport(hold)
      const input = renderComposer(structured)
      changePrompt(input, text)
      await act(async () => pressEnter(input))
      await act(async () =>
        fireEvent.click(await screen.findByRole('button', { name: 'Clear queue' }))
      )
      return { deleted, structured, input }
    }

    it('sending again sends nothing: the message goes out once, after the deletes', async () => {
      const { deleted, structured, input } = await clearingQueue('start over')
      // The draft still holds the message.
      expect(promptValue(input)).toBe('start over')
      await act(async () => pressEnter(input))
      await act(async () => fireEvent.click(screen.getByTestId('composer-send')))
      await act(async () => {})
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(structured.send).not.toHaveBeenCalled()
      await act(async () => deleted.resolve(true))
      await waitFor(() => expect(structured.send).toHaveBeenCalledWith('start over', []))
      await act(async () => {})
      expect(structured.send).toHaveBeenCalledTimes(1)
    })

    it('only the sent message leaves the composer; text typed meanwhile stays', async () => {
      const { deleted, structured, input } = await clearingQueue('start over')
      changePrompt(input, 'start over, and also check the tests')
      await act(async () => deleted.resolve(true))
      await waitFor(() => expect(structured.send).toHaveBeenCalledWith('start over', []))
      await act(async () => {})
      expect(promptValue(input)).toBe(', and also check the tests')
    })

    it('an unchanged draft is cleared once the message is accepted', async () => {
      const { deleted, structured, input } = await clearingQueue('start over')
      await act(async () => deleted.resolve(true))
      await waitFor(() => expect(structured.send).toHaveBeenCalledWith('start over', []))
      await waitFor(() => expect(promptValue(input)).toBe(''))
    })
  })

  it('does not ask when the queue is not held, nor for a command the host runs itself', async () => {
    const free = transport()
    const input = renderComposer(free)
    changePrompt(input, 'plain send')
    await act(async () => pressEnter(input))
    await waitFor(() => expect(free.send).toHaveBeenCalledWith('plain send', []))
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    const held = transport(heldQueue(2))
    const commandInput = renderComposer(held)
    changePrompt(commandInput, '/compact')
    await act(async () => pressEnter(commandInput))
    await waitFor(() => expect(held.dispatchCommand).toHaveBeenCalledWith('/compact'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes when the pause lifts under it: nothing is sent, the draft stays, and the next Enter sends', async () => {
    const held = transport(heldQueue(2))
    const composer = (structuredTransport: NativeChatStructuredComposerTransport) => (
      <NativeChatComposer
        terminalTabId="tab-lifted"
        paneKey="tab-lifted:structured"
        targetPtyId={null}
        agent="codex"
        structuredTransport={structuredTransport}
      />
    )
    const view = render(composer(held))
    const input = screen.getByRole('textbox')
    changePrompt(input, 'a new instruction')
    await act(async () => pressEnter(input))
    await screen.findByRole('dialog')
    // Orca's mail or another client's Resume lifts the pause: the host stops publishing the hold.
    const { queueHold: _lifted, ...lifted } = held
    view.rerender(composer(lifted))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(held.send).not.toHaveBeenCalled()
    expect(promptValue(input)).toBe('a new instruction')
    // A later pause does not bring the old question back.
    view.rerender(composer({ ...lifted, queueHold: heldQueue(1) }))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(composer(lifted))
    await act(async () => pressEnter(input))
    await waitFor(() => expect(held.send).toHaveBeenCalledWith('a new instruction', []))
    expect(held.send).toHaveBeenCalledTimes(1)
  })
})
