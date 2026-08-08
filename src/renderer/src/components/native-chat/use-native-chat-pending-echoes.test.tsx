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

type EchoProps = {
  sessionId: string | null
  messages: NativeChatMessage[]
  paneKey?: string
}

function renderEchoProps(initialProps: EchoProps) {
  // A fresh mock per render would model a caller React does not have: the only
  // one passes a `useState` setter, whose identity React guarantees is stable.
  const setWorkingInterrupted = vi.fn()
  return renderHook(
    (props: EchoProps) =>
      useNativeChatPendingEchoes({
        paneKey: props.paneKey ?? 'tab-1:leaf-1',
        agent: 'claude',
        sessionId: props.sessionId,
        messages: props.messages,
        setWorkingInterrupted
      }),
    { initialProps }
  )
}

function renderEchoes(sessionId: string | null, messages: NativeChatMessage[] = NO_MESSAGES) {
  return renderEchoProps({ sessionId, messages })
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

  it('does not judge a pane with the previous pane markers when the chat view moves', () => {
    // One portal per tab, so a leaf move changes paneKey in place — both scopes
    // change while the marker state still describes the leaf we came from.
    const { result, rerender } = renderEchoProps({
      sessionId: 'session-2',
      messages: NO_MESSAGES,
      paneKey: 'tab-1:leaf-2'
    })
    act(() => {
      result.current.recordSend('leaf two prompt')
    })
    rerender({ sessionId: 'session-1', messages: NO_MESSAGES, paneKey: 'tab-1:leaf-1' })
    act(() => {
      result.current.recordSlashCommand('/clear')
    })
    rerender({ sessionId: 'session-2', messages: NO_MESSAGES, paneKey: 'tab-1:leaf-2' })
    expect(result.current.pending.map((entry) => entry.text)).toEqual(['leaf two prompt'])
  })

  it('releases the occurrence a cancelled send would have taken', () => {
    const { result } = renderEchoes('session-1')
    let firstId = ''
    act(() => {
      firstId = result.current.recordSend('ping')
    })
    act(() => {
      result.current.recordSend('ping')
    })
    expect(result.current.pending.map((entry) => entry.matchingOccurrence)).toEqual([undefined, 2])
    act(() => {
      result.current.cancelSend(firstId)
    })
    expect(result.current.pending.map((entry) => entry.matchingOccurrence)).toEqual([1])
  })

  it('keeps the occurrence a capped-out echo owns when the session id first resolves', () => {
    // Sends before the launch reports its session id adopt that id — but adoption
    // drops nothing, so it must not renumber a trimmed echo's slot away.
    const { result, rerender } = renderEchoProps({ sessionId: null, messages: NO_MESSAGES })
    for (let index = 0; index < 9; index += 1) {
      act(() => {
        result.current.recordSend('ping')
      })
    }
    expect(result.current.pending).toHaveLength(8)
    expect(result.current.pending[0]?.matchingOccurrence).toBe(2)
    rerender({ sessionId: 'session-1', messages: NO_MESSAGES })
    expect(result.current.pending.map((entry) => entry.sessionId)).toEqual(
      Array.from({ length: 8 }, () => 'session-1')
    )
    expect(result.current.pending[0]?.matchingOccurrence).toBe(2)
  })

  it('keeps the occurrence a capped-out echo still owns when a later send is cancelled', () => {
    // The echo trimmed at PENDING_SEND_LIMIT still landed, so its turn still
    // consumes an occurrence that a later cancellation must not renumber away.
    const { result } = renderEchoes('session-1')
    for (let index = 0; index < 9; index += 1) {
      act(() => {
        result.current.recordSend('ping')
      })
    }
    expect(result.current.pending).toHaveLength(8)
    expect(result.current.pending[0]?.matchingOccurrence).toBe(2)
    const survivorId = result.current.pending[1]?.id ?? ''
    act(() => {
      result.current.cancelSend(result.current.pending[0]?.id ?? '')
    })
    expect(result.current.pending[0]?.id).toBe(survivorId)
    // Was 3 (behind the trimmed and the cancelled echo); only one slot released.
    expect(result.current.pending[0]?.matchingOccurrence).toBe(2)
  })
})
