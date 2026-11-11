// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { useNativeChatDraft } from '../../drafts/use-native-chat-draft'
import {
  consumeNativeChatShellRuns,
  registerNativeChatShellHost,
  runNativeChatShellCommand,
  setNativeChatShellRunAdded,
  useNativeChatShellRuns
} from '../../shell/native-chat-shell-runs'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))

const scope = 'agent-session:shell-send'

function transport(): NativeChatStructuredComposerTransport {
  return {
    capturePresentation: () => () => true,
    send: vi.fn(() => true),
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'shell-send',
    runtimeEnvironmentId: null
  }
}

function mount(structuredTransport: NativeChatStructuredComposerTransport) {
  return renderHook(() => {
    const draft = useNativeChatDraft(scope, () => false)
    const send = useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: scope,
      imageAttachments: [],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: () => {},
      setDraft: draft.setDraft,
      setCaret: () => {}
    })
    return { ...draft, send, runs: useNativeChatShellRuns(() => true) }
  })
}

async function sendText(hook: ReturnType<typeof mount>, text: string): Promise<void> {
  act(() => hook.result.current.setDraft(text))
  await act(async () => {
    await hook.result.current.send(text, [])
  })
}

describe('structured send with shell results', () => {
  let unregister: () => void = () => {}

  beforeEach(async () => {
    localStorage.clear()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    await hydrateNativeChatComposerDrafts()
    unregister = registerNativeChatShellHost(scope, {
      run: (command, sink) => {
        sink.frame({
          type: 'output',
          chunks: [{ stream: 'stdout', text: command === 'pwd' ? '/repo\n' : 'ok\n' }]
        })
        sink.frame({
          type: 'exit',
          exitCode: 0,
          timedOut: false,
          outputTruncated: false
        })
        return () => {}
      },
      anchor: () => ({ id: 'message-1', awaitingTurn: false })
    })
  })

  afterEach(() => {
    unregister()
    clearNativeChatComposerDraftsForTests()
  })

  it('keeps a result the user did not add out of the prompt', async () => {
    const sink = transport()
    const hook = mount(sink)
    act(() => runNativeChatShellCommand(scope, 'pwd'))
    await waitFor(() => expect(hook.result.current.runs[0]?.exit).toBeDefined())
    await sendText(hook, 'hello')
    expect(vi.mocked(sink.send).mock.calls[0]?.[0]).toBe('hello')
    expect(hook.result.current.runs).toHaveLength(1)
    act(() => consumeNativeChatShellRuns(hook.result.current.runs.map(({ id }) => id)))
    hook.unmount()
  })

  it('appends added results to the prompt and clears only those cards after acceptance', async () => {
    const sink = transport()
    const hook = mount(sink)
    act(() => {
      runNativeChatShellCommand(scope, 'pwd')
      runNativeChatShellCommand(scope, 'echo ok')
    })
    await waitFor(() =>
      expect(hook.result.current.runs.every((run) => run.exit !== undefined)).toBe(true)
    )
    const [added, kept] = hook.result.current.runs
    act(() => setNativeChatShellRunAdded(added.id, true))
    await sendText(hook, 'explain this')
    expect(vi.mocked(sink.send).mock.calls[0]?.[0]).toBe(
      'explain this\n\n```console\n$ pwd\n/repo\n```'
    )
    expect(hook.result.current.runs.map(({ id }) => id)).toEqual([kept.id])
    act(() => consumeNativeChatShellRuns([kept.id]))
    hook.unmount()
  })

  it('sends an added result alone from an empty composer', async () => {
    const sink = transport()
    const hook = mount(sink)
    act(() => runNativeChatShellCommand(scope, 'pwd'))
    await waitFor(() => expect(hook.result.current.runs[0]?.exit).toBeDefined())
    act(() => setNativeChatShellRunAdded(hook.result.current.runs[0].id, true))
    await sendText(hook, '')
    expect(vi.mocked(sink.send).mock.calls[0]?.[0]).toBe('```console\n$ pwd\n/repo\n```')
    expect(hook.result.current.runs).toHaveLength(0)
    hook.unmount()
  })
})
