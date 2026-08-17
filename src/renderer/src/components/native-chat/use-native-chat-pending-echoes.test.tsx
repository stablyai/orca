// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { clearNativeChatConversationBindingsForTests } from './native-chat-pending-conversation'
import {
  clearCommandMarkerCacheForTests,
  clearPendingSendCacheForTests,
  pendingSendsAsMessages
} from './native-chat-pending'
import {
  useNativeChatPendingEchoes,
  type NativeChatPendingEchoesInput
} from './use-native-chat-pending-echoes'

const PANE = 'tab-1:leaf-1'
// Echo matching compares transcript timestamps against the send's own clock, so
// the test drives both from one fake clock rather than mixing Date.now() with
// hand-written message timestamps.
const CLOCK_START = 1_700_000_000_000

function userMessage(id: string, text: string, timestamp: number): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function assistantMessage(id: string, text: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function renderEchoes(initial: Partial<NativeChatPendingEchoesInput> = {}) {
  const props: NativeChatPendingEchoesInput = {
    paneKey: PANE,
    agent: 'codex',
    sessionId: 'session-a',
    messages: [],
    ...initial
  }
  return renderHook((next: NativeChatPendingEchoesInput) => useNativeChatPendingEchoes(next), {
    initialProps: props
  })
}

/** The prompt texts the list would render as optimistic bubbles. */
function echoedTexts(
  pending: ReturnType<typeof useNativeChatPendingEchoes>['pending'],
  messages: NativeChatMessage[]
): string[] {
  return pendingSendsAsMessages(pending, messages).flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  )
}

describe('useNativeChatPendingEchoes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: CLOCK_START })
    clearPendingSendCacheForTests()
    clearCommandMarkerCacheForTests()
    clearNativeChatConversationBindingsForTests()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders the echo until its own user turn lands, then retires it', () => {
    const view = renderEchoes()
    act(() => {
      view.result.current.onOptimisticSend('summarize the release notes')
    })
    expect(echoedTexts(view.result.current.pending, [])).toEqual(['summarize the release notes'])

    const settled = [
      userMessage('a1', 'summarize the release notes', CLOCK_START + 100),
      assistantMessage('a2', 'Here are the notes.', CLOCK_START + 200)
    ]
    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-a', messages: settled })

    expect(view.result.current.pending).toEqual([])
  })

  it('leaves a replaced conversation unable to reach its predecessor echo', () => {
    const view = renderEchoes()
    act(() => {
      view.result.current.onOptimisticSend('summarize the release notes')
    })
    expect(view.result.current.pending).toHaveLength(1)

    // The pane's conversation is replaced — /clear, an agent restart, or
    // resuming a different session. paneKey and agent are unchanged; only the
    // provider session id moves.
    const replacement = [
      userMessage('b1', 'what changed in v2?', CLOCK_START + 5_000),
      assistantMessage('b2', 'Here is the v2 changelog.', CLOCK_START + 5_100)
    ]
    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-b', messages: replacement })

    expect(view.result.current.pending).toEqual([])
    expect(echoedTexts(view.result.current.pending, replacement)).toEqual([])
  })

  it('does not expose predecessor pending during the replacement render', () => {
    const renders: string[][] = []
    const props: NativeChatPendingEchoesInput = {
      paneKey: PANE,
      agent: 'codex',
      sessionId: 'session-a',
      messages: []
    }
    const view = renderHook(
      (next: NativeChatPendingEchoesInput) => {
        const current = useNativeChatPendingEchoes(next)
        renders.push(current.pending.map((entry) => entry.text))
        return current
      },
      { initialProps: props }
    )
    act(() => view.result.current.onOptimisticSend('predecessor prompt'))
    renders.length = 0

    view.rerender({ ...props, sessionId: 'session-b' })

    expect(renders[0]).toEqual([])
  })

  it('keeps the predecessor echo unreachable across a remount', () => {
    const first = renderEchoes()
    act(() => {
      first.result.current.onOptimisticSend('summarize the release notes')
    })
    first.unmount()

    // Native/TUI view switches remount the chat surface, which re-seeds state
    // from the pane cache. The replacement conversation reads a different key.
    const second = renderEchoes({ sessionId: 'session-b' })
    expect(second.result.current.pending).toEqual([])
  })

  it('restores the live conversation echo across a remount', () => {
    const first = renderEchoes()
    act(() => {
      first.result.current.onOptimisticSend('still waiting on this one')
    })
    first.unmount()

    const second = renderEchoes()
    expect(second.result.current.pending.map((entry) => entry.text)).toEqual([
      'still waiting on this one'
    ])
  })

  it('hands a pre-identity echo to the first conversation the pane reports', () => {
    const view = renderEchoes({ sessionId: null })
    act(() => {
      view.result.current.onOptimisticSend('first prompt in a fresh pane')
    })

    // A fresh launch learns its provider session id only after the first send.
    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-a', messages: [] })

    expect(view.result.current.pending.map((entry) => entry.text)).toEqual([
      'first prompt in a fresh pane'
    ])
  })

  it('hands the pre-identity echo on once and no replacement gets it after', () => {
    const view = renderEchoes({ sessionId: null })
    act(() => {
      view.result.current.onOptimisticSend('first prompt in a fresh pane')
    })
    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-a', messages: [] })
    expect(view.result.current.pending).toHaveLength(1)

    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-b', messages: [] })
    expect(view.result.current.pending).toEqual([])

    // And the closed bucket cannot be re-claimed by a third conversation, even
    // though the pane briefly reports no session id in between.
    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: null, messages: [] })
    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-c', messages: [] })
    expect(view.result.current.pending).toEqual([])
  })

  it('refuses the claim for an echo queued at or before a /clear in the same window', () => {
    const view = renderEchoes({ sessionId: null })
    act(() => {
      view.result.current.onOptimisticSend('sent just before the clear')
    })
    act(() => {
      vi.setSystemTime(CLOCK_START + 10)
      view.result.current.onSlashCommand('/clear')
    })
    act(() => {
      vi.setSystemTime(CLOCK_START + 20)
      view.result.current.onOptimisticSend('sent after the clear')
    })

    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-a', messages: [] })

    expect(view.result.current.pending.map((entry) => entry.text)).toEqual(['sent after the clear'])
  })

  it('keeps each pane on its own conversation bucket', () => {
    const left = renderEchoes()
    act(() => {
      left.result.current.onOptimisticSend('left pane prompt')
    })
    const right = renderEchoes({ paneKey: 'tab-2:leaf-2' })
    act(() => {
      right.result.current.onOptimisticSend('right pane prompt')
    })

    // Replacing the right pane's conversation must not disturb the left pane.
    right.rerender({
      paneKey: 'tab-2:leaf-2',
      agent: 'codex',
      sessionId: 'session-b',
      messages: []
    })

    expect(right.result.current.pending).toEqual([])
    expect(left.result.current.pending.map((entry) => entry.text)).toEqual(['left pane prompt'])
  })

  it('drops the live conversation echoes on Stop without touching a sibling pane', () => {
    const left = renderEchoes()
    act(() => {
      left.result.current.onOptimisticSend('left pane prompt')
    })
    const right = renderEchoes({ paneKey: 'tab-2:leaf-2' })
    act(() => {
      right.result.current.onOptimisticSend('right pane prompt')
    })

    act(() => {
      right.result.current.clearPendingSends()
    })

    expect(right.result.current.pending).toEqual([])
    expect(left.result.current.pending.map((entry) => entry.text)).toEqual(['left pane prompt'])
  })

  it('cancels a single echo by id and leaves the rest queued', () => {
    const view = renderEchoes()
    let cancelledId = ''
    act(() => {
      cancelledId = view.result.current.onOptimisticSend('cancel me')
    })
    act(() => {
      view.result.current.onOptimisticSend('keep me')
    })

    act(() => {
      view.result.current.onOptimisticSendCanceled(cancelledId)
    })

    expect(view.result.current.pending.map((entry) => entry.text)).toEqual(['keep me'])
  })

  it('scopes command markers to the conversation that recorded them', () => {
    const view = renderEchoes()
    act(() => {
      view.result.current.onSlashCommand('/clear')
    })
    expect(view.result.current.commandMarkers.map((marker) => marker.command)).toEqual(['/clear'])

    view.rerender({ paneKey: PANE, agent: 'codex', sessionId: 'session-b', messages: [] })

    expect(view.result.current.commandMarkers).toEqual([])
  })
})
