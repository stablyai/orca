// @vitest-environment happy-dom

/**
 * A user typing into a structured worker's chat pane is a TAKEOVER.
 *
 * The guard has always existed — `worker_terminal_resources.ownership_state = 'user_owned'` makes
 * `worker-release` retain with `user_takeover` — and for a structured worker it was simply never
 * armed: `reportWorkerTerminalUserInput` has one call site, on a PTY connection. So a user
 * mid-conversation in a chat pane had their session closed and its tab retired, while
 * `orchestration-worker-specs.ts` promised "Never closes … user-taken-over terminals".
 */

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const reportStructuredSessionUserInput = vi.hoisted(() => vi.fn())
const dispatchStructuredComposerText = vi.hoisted(() => vi.fn())

vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput,
  reportWorkerTerminalUserInput: vi.fn()
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('./native-chat-structured-composer-dispatch', () => ({
  dispatchNativeChatStructuredComposerText: dispatchStructuredComposerText
}))

import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

function transport(): NativeChatStructuredComposerTransport {
  return {
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
    sessionId: 'session-1',
    runtimeEnvironmentId: null
  }
}

function send(structuredTransport: NativeChatStructuredComposerTransport): (text: string) => void {
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'claude',
      imageAttachments: [],
      structuredTransport,
      clearImageAttachments: vi.fn(),
      clearSkillOrigin: vi.fn(),
      setHistory: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  return result.current
}

describe('a real user send from a structured chat pane', () => {
  it('reports the takeover, addressed by session and never by pane key', async () => {
    // By session on purpose: the worker's pane key is a random identity credential held in main,
    // and a renderer echoing it back would make it learnable by anyone who can see a chat pane.
    reportStructuredSessionUserInput.mockClear()
    dispatchStructuredComposerText.mockResolvedValue({ accepted: true, error: null })
    send(transport())('ship it')
    await vi.waitFor(() =>
      expect(reportStructuredSessionUserInput).toHaveBeenCalledWith('session-1', null)
    )
  })

  it('reports nothing when the transport refused the send', async () => {
    // A refused send is not a takeover; relinquishing ownership on one would retain every worker
    // whose composer merely errored.
    reportStructuredSessionUserInput.mockClear()
    dispatchStructuredComposerText.mockResolvedValue({ accepted: false, error: 'nope' })
    send(transport())('ship it')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reportStructuredSessionUserInput).not.toHaveBeenCalled()
  })
})
