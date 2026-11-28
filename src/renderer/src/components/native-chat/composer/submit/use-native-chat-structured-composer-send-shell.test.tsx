// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

const openTab = vi.hoisted(() =>
  vi.fn(
    (
      _worktreeId: string | null,
      _shell?: string,
      options?: { command?: string; onSettled?: (started: boolean) => void }
    ) => options?.onSettled?.(tabStarts.value)
  )
)
const tabStarts = vi.hoisted(() => ({ value: true }))
vi.mock('@/components/terminal/terminal-tab-create', () => ({ createNewTerminalTab: openTab }))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))

function transport(
  overrides: Partial<NativeChatStructuredComposerTransport> = {}
): NativeChatStructuredComposerTransport {
  const base: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'shell',
    runtimeEnvironmentId: null,
    worktreeId: 'repo::/work/tree'
  }
  return { ...base, ...overrides }
}

function renderSend(structuredTransport: NativeChatStructuredComposerTransport) {
  const setDraft = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: 'agent-session:shell',
      imageAttachments: [],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft,
      setCaret: vi.fn()
    })
  )
  return { send: result.current, setDraft }
}

describe('! commands in a structured chat', () => {
  beforeEach(async () => {
    localStorage.clear()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    await hydrateNativeChatComposerDrafts()
    openTab.mockClear()
    tabStarts.value = true
  })
  afterEach(() => {
    clearNativeChatComposerDraftsForTests()
  })

  it('runs the command in a terminal and never sends it to the agent', async () => {
    const chat = transport()
    const { send, setDraft } = renderSend(chat)
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await send('! secrets status', [])
    })
    expect(accepted).toBe(true)
    expect(openTab).toHaveBeenCalledWith('repo::/work/tree', undefined, {
      command: 'secrets status',
      onSettled: expect.any(Function)
    })
    expect(chat.send).not.toHaveBeenCalled()
    expect(chat.dispatchCommand).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledWith('')
  })

  it('keeps the draft and says so when the terminal cannot start', async () => {
    tabStarts.value = false
    const chat = transport()
    const { send, setDraft } = renderSend(chat)
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await send('!pwd', [])
    })
    expect(accepted).toBe(false)
    expect(chat.onError).toHaveBeenCalledWith('Could not start the ! command in a terminal.')
    expect(chat.send).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('sends a ! draft to the agent as before when the chat has no workspace', async () => {
    const chat = transport({ worktreeId: undefined })
    const { send } = renderSend(chat)
    await act(async () => {
      await send('!pwd', [])
    })
    expect(openTab).not.toHaveBeenCalled()
    expect(chat.send).toHaveBeenCalled()
  })

  it('sends an ordinary message to the agent', async () => {
    const chat = transport()
    const { send } = renderSend(chat)
    await act(async () => {
      await send('please run pwd', [])
    })
    expect(openTab).not.toHaveBeenCalled()
    expect(chat.send).toHaveBeenCalled()
  })
})
