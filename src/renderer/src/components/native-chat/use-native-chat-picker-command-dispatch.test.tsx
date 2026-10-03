// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_HISTORY } from './native-chat-composer-state'
import {
  clearNativeChatDraftCacheForTests,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { installNativeChatDrafts } from './native-chat-draft-store.test-support'

const sendNativeChatMessage = vi.fn()
const sendNativeChatTypedCommand = vi.fn()

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendNativeChatTypedCommand(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))

import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'

const COMMAND = {
  kind: 'command' as const,
  id: 'command:status',
  name: 'status',
  token: '/status',
  description: 'Show status',
  skillCollision: false
}

const DRAFT_KEY = 'pane:tab-1:leaf-1'

function renderDispatch(agent: 'codex' | 'claude' | 'openclaude') {
  return renderHook(() =>
    useNativeChatPickerCommandDispatch({
      agent,
      draftKey: DRAFT_KEY,
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: () => ({ settings: {}, ptyId: 'pty-1' }),
      sessionOptionsSurface: null,
      trackPendingSend: vi.fn(),
      setHistory: vi.fn((update) => update(EMPTY_HISTORY)),
      // As the composer's draft hook does: a clear is saved at once.
      setDraft: (value: string) => writeNativeChatDraftCache(DRAFT_KEY, value, 'now'),
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
}

describe('useNativeChatPickerCommandDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const handle = { cancel: vi.fn(), settleAfterMs: 0 }
    sendNativeChatMessage.mockReturnValue(handle)
    sendNativeChatTypedCommand.mockReturnValue(handle)
  })

  afterEach(async () => {
    // Lets each send's draft save land in its own test.
    await new Promise((resolve) => setTimeout(resolve, 0))
    clearNativeChatDraftCacheForTests()
  })

  it('types Codex autocomplete commands', () => {
    const hook = renderDispatch('codex')
    act(() => hook.result.current(COMMAND))

    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith({}, 'pty-1', '/status')
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it.each(['claude', 'openclaude'] as const)('keeps %s autocomplete commands pasted', (agent) => {
    const hook = renderDispatch(agent)
    act(() => hook.result.current(COMMAND))

    expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/status')
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })
})

// A command picked from the menu goes out like a typed one: its clear is saved once the
// terminal write ran, so a crash before then restores it unsent.
describe('a command picked from the menu', () => {
  afterEach(async () => {
    // Lets each send's draft save land in its own test.
    await new Promise((resolve) => setTimeout(resolve, 0))
    clearNativeChatDraftCacheForTests()
  })

  it('keeps its text saved until the terminal write ran', async () => {
    const saved: unknown[] = []
    installNativeChatDrafts({
      load: async () => [],
      loadSync: () => [],
      write: async (_scopeKey, draft) => {
        saved.push(draft?.text ?? null)
        return 'persisted'
      }
    })
    let finish = () => {}
    sendNativeChatTypedCommand.mockReturnValue({
      cancel: vi.fn(),
      settleAfterMs: 0,
      settled: new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    writeNativeChatDraftCache(DRAFT_KEY, '/sta', 'now')
    const hook = renderDispatch('codex')

    act(() => hook.result.current(COMMAND))
    await Promise.resolve()
    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith({}, 'pty-1', '/status')
    expect(saved).toEqual(['/sta'])

    finish()
    await vi.waitFor(() => expect(saved).toEqual(['/sta', null]))
  })
})
