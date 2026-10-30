// @vitest-environment happy-dom

/** Accepted chat input must claim structured workers for the user so orchestration release cannot close their active conversation. */

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
    sessionId: 'session-1',
    runtimeEnvironmentId: null
  }
}

function send(structuredTransport: NativeChatStructuredComposerTransport): (text: string) => void {
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: 'tab-1:pane',
      imageAttachments: [],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  return result.current
}

describe('a real user send from a structured chat pane', () => {
  it('reports the takeover, addressed by session and never by pane key', async () => {
    // Use session identity; exposing main’s random pane-key credential would leak takeover authority.
    reportStructuredSessionUserInput.mockClear()
    dispatchStructuredComposerText.mockResolvedValue({ accepted: true, error: null })
    send(transport())('ship it')
    await vi.waitFor(() =>
      expect(reportStructuredSessionUserInput).toHaveBeenCalledWith('session-1', null)
    )
  })

  it('reports nothing when the transport refused the send', async () => {
    reportStructuredSessionUserInput.mockClear()
    dispatchStructuredComposerText.mockResolvedValue({ accepted: false, error: 'nope' })
    send(transport())('ship it')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reportStructuredSessionUserInput).not.toHaveBeenCalled()
  })
})
