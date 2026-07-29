// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  clearCommandMarkerCacheForTests,
  clearPendingSendCacheForTests
} from './native-chat-pending'
import { useNativeChatPendingEchoes } from './use-native-chat-pending-echoes'

const NO_MESSAGES: NativeChatMessage[] = []

function renderEchoes(sessionId: string | null, messages: NativeChatMessage[] = NO_MESSAGES) {
  return renderHook(
    (props: { sessionId: string | null; messages: NativeChatMessage[] }) =>
      useNativeChatPendingEchoes({
        paneKey: 'tab-1:leaf-1',
        agent: 'claude',
        sessionId: props.sessionId,
        messages: props.messages,
        setWorkingInterrupted: vi.fn()
      }),
    { initialProps: { sessionId, messages } }
  )
}

describe('useNativeChatPendingEchoes', () => {
  afterEach(() => {
    clearPendingSendCacheForTests()
    clearCommandMarkerCacheForTests()
  })

  it('keeps an echo while the conversation is unchanged', () => {
    const { result } = renderEchoes('session-1')
    act(() => {
      result.current.recordSend('summarize the diff')
    })
    expect(result.current.pending.map((entry) => entry.text)).toEqual(['summarize the diff'])
  })

  it('drops an echo once the pane swaps to another provider session', () => {
    const { result, rerender } = renderEchoes('session-1')
    act(() => {
      result.current.recordSend('summarize the diff')
    })
    rerender({ sessionId: 'session-2', messages: NO_MESSAGES })
    expect(result.current.pending).toEqual([])
  })

  it('keeps an echo sent before the session id resolved, then binds it', () => {
    const { result, rerender } = renderEchoes(null)
    act(() => {
      result.current.recordSend('first prompt')
    })
    rerender({ sessionId: 'session-1', messages: NO_MESSAGES })
    expect(result.current.pending.map((entry) => entry.sessionId)).toEqual(['session-1'])
    rerender({ sessionId: 'session-2', messages: NO_MESSAGES })
    expect(result.current.pending).toEqual([])
  })

  it('drops an echo queued before /clear reset the transcript', () => {
    const { result } = renderEchoes('session-1')
    act(() => {
      result.current.recordSend('summarize the diff')
    })
    act(() => {
      result.current.recordSlashCommand('/clear')
    })
    expect(result.current.pending).toEqual([])
  })
})
