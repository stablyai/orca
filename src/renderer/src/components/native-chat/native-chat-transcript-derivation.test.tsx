// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { expect, it, vi } from 'vitest'
import type * as MessageRowModule from './NativeChatMessageRow'
import type { MessageRowProps } from './NativeChatMessageRow'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  marker,
  session,
  stubLayout,
  stubResizeObserver
} from './native-chat-windowing-test-harness'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { useNativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'

// Measurement renders need new virtual geometry, not new history keys or prompt previews.
it.each([100, 1000])(
  'does no structural row reads on measurement-only renders at %i rows',
  (size) => {
    let reads = 0
    const messages = Array.from({ length: size }, (_, index) => ({
      id: `row-${index}`,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `prompt ${index}` }],
      timestamp: index,
      source: 'transcript' as const
    }))
    const slots = buildNativeChatTranscriptSlots({
      messages,
      turnKeys: messages.map((row) => row.id),
      liveTurnKey: undefined,
      receipts: new Map(),
      turnStatuses: { active: null, completedByTurn: {} },
      turnDiffs: new Map(),
      expandedTurnKeys: new Set(),
      isWorking: false,
      lifecycleWorking: false
    })
    for (const row of messages) {
      const id = row.id
      const blocks = row.blocks
      Object.defineProperties(row, {
        id: {
          get: () => {
            reads++
            return id
          }
        },
        blocks: {
          get: () => {
            reads++
            return blocks
          }
        }
      })
    }
    const scrollRef = { current: null }
    const turnRows = { messages, turnKeys: messages.map((row) => row.id) }
    const view = renderHook(
      ({ slots, revealIndex }) => {
        const window = useNativeChatTranscriptWindow({
          scrollRef,
          slots,
          isVisible: true,
          revealIndex
        })
        return useNativeChatMessageRail({
          scrollRef,
          slots,
          turnRows,
          virtualItems: window.virtualItems
        })
      },
      { initialProps: { slots, revealIndex: -1 } }
    )
    expect(view.result.current.items).toHaveLength(size)
    reads = 0
    view.rerender({ slots, revealIndex: 0 })
    expect(reads).toBe(0)
    view.rerender({ slots: slots.slice(1), revealIndex: 0 })
    expect(view.result.current.items).toHaveLength(size - 1)
    expect(view.result.current.items[0]?.id).toBe('row-1')
    view.unmount()
  }
)

const rowRenders = vi.hoisted(() => [] as string[])
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: () => {
    throw new Error('Unexpected inline visual')
  }
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: () => {
    throw new Error('Unexpected sender navigation')
  }
}))
vi.mock('./NativeChatMessageRow', async (importOriginal) => {
  const actual = await importOriginal<typeof MessageRowModule>()
  const { memo } = await import('react')
  return {
    ...actual,
    MessageRow: memo((props: MessageRowProps) => {
      rowRenders.push(props.message.id)
      return <actual.MessageRow {...props} />
    })
  }
})

it('renders only the changed mounted message during a streaming update', async () => {
  const restoreLayout = stubLayout({ scrollGeometry: true })
  const restoreResize = stubResizeObserver()
  const rows = [
    ...Array.from({ length: 100 }, (_, index) => ({ ...marker(index), role: 'user' as const })),
    { ...marker(100), id: 'live' }
  ]
  const element = (messages: typeof rows) => (
    <NativeChatMessageList session={session(messages)} isWorking={false} expandSignal={false} />
  )
  const view = render(element(rows))
  try {
    await act(async () => {})
    expect(rowRenders).toContain('live')
    rowRenders.length = 0
    view.rerender(
      element([
        ...rows.slice(0, -1),
        { ...rows.at(-1)!, blocks: [{ type: 'text', text: 'Streaming answer grows' }] }
      ])
    )
    await act(async () => {})
    expect(rowRenders).toEqual(['live'])
  } finally {
    view.unmount()
    restoreResize()
    restoreLayout()
  }
})
