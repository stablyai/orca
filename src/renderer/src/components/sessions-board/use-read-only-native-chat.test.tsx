// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_INITIAL_LIMIT, NATIVE_CHAT_PAGE } from '../native-chat/native-chat-pagination'
import { useReadOnlyNativeChat } from './use-read-only-native-chat'

const readSession = vi.fn()

function message(text: string): NativeChatMessage {
  return {
    id: text,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:sess-1:/home/a/.claude/sess-1.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'sess-1',
    title: 'A session',
    cwd: '/home/a/project',
    branch: null,
    model: null,
    filePath: '/home/a/.claude/sess-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume sess-1',
    subagent: null,
    ...overrides
  }
}

let previousApi: Window['api']

/** Only this hook's slice of the bridge exists under test, so it is defined rather than cast. */
function setWindowApi(api: unknown): void {
  Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true })
}

beforeEach(() => {
  readSession.mockReset()
  previousApi = window.api
  setWindowApi({ nativeChat: { readSession } })
})

afterEach(() => {
  setWindowApi(previousApi)
})

describe('useReadOnlyNativeChat', () => {
  it('reads the session transcript at the initial window and hands back a ready session', async () => {
    readSession.mockResolvedValue({ messages: [message('one'), message('two')] })

    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession()))

    expect(result.current.phase).toBe('loading')
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    expect(readSession).toHaveBeenCalledWith(
      'claude',
      'sess-1',
      NATIVE_CHAT_INITIAL_LIMIT,
      '/home/a/.claude/sess-1.jsonl'
    )
    expect(result.current.transcript).toMatchObject({
      messages: [message('one'), message('two')],
      status: 'ready',
      readPhase: 'ready',
      sessionId: 'sess-1',
      agent: 'claude'
    })
  })

  it('reports a transcript that is not on disk yet as unwritten, not as a failure', async () => {
    readSession.mockResolvedValue({ error: 'missing', notFound: true })

    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession()))

    await waitFor(() => expect(result.current.phase).toBe('notWritten'))
    expect(result.current.error).toBeNull()
    expect(result.current.transcript).toBeNull()
  })

  it('surfaces a read failure verbatim', async () => {
    readSession.mockResolvedValue({ error: 'Host is not reachable' })

    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession()))

    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.error).toBe('Host is not reachable')
  })

  it('reports a rejected read as an error instead of hanging on loading', async () => {
    readSession.mockRejectedValue(new Error('IPC is down'))

    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession()))

    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.error).toBe('IPC is down')
  })

  it('never reads a transcript the decoder cannot handle', async () => {
    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession({ agent: 'gemini' })))

    expect(result.current.phase).toBe('unsupported')
    expect(readSession).not.toHaveBeenCalled()
  })

  it('grows the window by one page and reports whether older history remains', async () => {
    readSession.mockResolvedValue({ messages: [message('tail')] })
    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession()))
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    readSession.mockResolvedValue({
      messages: Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE }, (_, index) =>
        message(`m-${index}`)
      )
    })
    let outcome = ''
    await act(async () => {
      outcome = await result.current.loadEarlier()
    })

    expect(readSession).toHaveBeenLastCalledWith(
      'claude',
      'sess-1',
      NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE,
      '/home/a/.claude/sess-1.jsonl'
    )
    expect(outcome).toBe('applied')
    expect(result.current.transcript?.hasMore).toBe(true)
  })

  it('reports exhausted once the read returns fewer messages than it asked for', async () => {
    readSession.mockResolvedValue({ messages: [message('only')] })
    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession()))
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    let outcome = ''
    await act(async () => {
      outcome = await result.current.loadEarlier()
    })

    expect(outcome).toBe('exhausted')
    expect(result.current.transcript?.hasMore).toBe(false)
  })

  it('re-reads from the top on retry, because the transcript may have been written since', async () => {
    readSession.mockResolvedValue({ error: 'missing', notFound: true })
    const { result } = renderHook(() => useReadOnlyNativeChat(makeSession()))
    await waitFor(() => expect(result.current.phase).toBe('notWritten'))

    readSession.mockResolvedValue({ messages: [message('now here')] })
    act(() => {
      result.current.retry()
    })

    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(readSession).toHaveBeenLastCalledWith(
      'claude',
      'sess-1',
      NATIVE_CHAT_INITIAL_LIMIT,
      '/home/a/.claude/sess-1.jsonl'
    )
  })
})
