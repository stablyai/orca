// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { clearPendingSendCacheForTests, readPendingSendCache } from './native-chat-pending'
import { clearPendingSendRetractionListenersForTests } from './native-chat-pending-retraction'
import { useNativeChatPendingSends } from './use-native-chat-pending-sends'

const SCOPE = { paneKey: 'pane-1', agent: 'claude' }

// Echoes match only against transcript rows that landed after the send, so the
// timestamps have to sit ahead of the real clock `issue` stamps them with.
function transcriptMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: Date.now() + 10_000,
    source: 'transcript'
  }
}

function renderPendingSends(messages: NativeChatMessage[] = []) {
  const initialProps: { messages: NativeChatMessage[] } = { messages }
  return renderHook(
    (props: { messages: NativeChatMessage[] }) =>
      useNativeChatPendingSends({ scope: SCOPE, messages: props.messages }),
    { initialProps }
  )
}

afterEach(() => {
  clearPendingSendCacheForTests()
  clearPendingSendRetractionListenersForTests()
})

describe('useNativeChatPendingSends', () => {
  it('echoes a submitted draft and adopts the pane cache on a later mount', () => {
    const first = renderPendingSends()
    act(() => {
      first.result.current.issue('hello')
    })
    expect(first.result.current.pending.map((entry) => entry.text)).toEqual(['hello'])
    first.unmount()

    const second = renderPendingSends()

    expect(second.result.current.pending.map((entry) => entry.text)).toEqual(['hello'])
  })

  it('retracts the echo from a replacement view that mounted before the send failed', () => {
    // The exact shape of the RPC failure path: the view that echoed the send
    // unmounts (Chat -> Terminal), the pane rebinds, a replacement view mounts
    // and snapshots the echo out of the pane cache, and only THEN does the old
    // send reject and call the canceler the old view handed to the composer.
    // Retracting through that old view's own state setter is inert, so the
    // replacement view has to learn about it too — otherwise an undelivered
    // message keeps rendering as sent.
    const first = renderPendingSends()
    let pendingId = ''
    act(() => {
      pendingId = first.result.current.issue('undelivered')
    })
    const retractFromUnmountedView = first.result.current.retract
    first.unmount()

    const second = renderPendingSends()
    expect(second.result.current.pending.map((entry) => entry.text)).toEqual(['undelivered'])

    act(() => {
      retractFromUnmountedView(pendingId)
    })

    expect(second.result.current.pending).toEqual([])
    expect(readPendingSendCache(SCOPE)).toEqual([])
  })

  it('keeps a retracted echo out of the cache when the replacement view next prunes', () => {
    // The write-back that made the retraction reappear: the mounted view's
    // prune effect writes its own snapshot to the pane cache on every
    // transcript change, so a snapshot still holding the echo restores it.
    const first = renderPendingSends()
    let pendingId = ''
    act(() => {
      pendingId = first.result.current.issue('undelivered')
    })
    const retractFromUnmountedView = first.result.current.retract
    first.unmount()

    const second = renderPendingSends()
    act(() => {
      retractFromUnmountedView(pendingId)
    })
    // An unrelated transcript update lands afterwards.
    act(() => {
      second.rerender({ messages: [transcriptMessage('m1', 'assistant', 'still working')] })
    })

    expect(second.result.current.pending).toEqual([])
    expect(readPendingSendCache(SCOPE)).toEqual([])
  })

  it("retracts only the named echo, never the replacement session's own", () => {
    const first = renderPendingSends()
    let pendingId = ''
    act(() => {
      pendingId = first.result.current.issue('undelivered')
    })
    const retractFromUnmountedView = first.result.current.retract
    first.unmount()

    const second = renderPendingSends()
    act(() => {
      second.result.current.issue('live send')
    })

    act(() => {
      retractFromUnmountedView(pendingId)
    })

    expect(second.result.current.pending.map((entry) => entry.text)).toEqual(['live send'])
  })

  it('prunes an echo once its real user turn has been answered', () => {
    const hook = renderPendingSends()
    act(() => {
      hook.result.current.issue('hello')
    })

    act(() => {
      hook.rerender({
        messages: [
          transcriptMessage('m1', 'user', 'hello'),
          transcriptMessage('m2', 'assistant', 'hi')
        ]
      })
    })

    expect(hook.result.current.pending).toEqual([])
  })
})
