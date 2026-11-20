// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type * as SessionAssembler from './native-chat-session-assembler'
import { useNativeChatAssembledMessages } from './use-native-chat-assembled-messages'

const merges = vi.hoisted(() => ({ count: 0 }))

vi.mock('./native-chat-session-assembler', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionAssembler>()
  return {
    ...actual,
    mergeOne: (...args: Parameters<typeof actual.mergeOne>) => {
      merges.count += 1
      actual.mergeOne(...args)
    }
  }
})

function row(index: number, text = `row ${index}`): NativeChatMessage {
  return {
    id: `m${index}`,
    role: index % 2 ? 'assistant' : 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1000 + index,
    source: 'transcript',
    transcriptOrder: index * 100
  }
}

function rows(from: number, to: number): NativeChatMessage[] {
  return Array.from({ length: to - from }, (_, offset) => row(from + offset))
}

type Props = { baseMessages: readonly NativeChatMessage[]; appended: NativeChatMessage[] }

function mountHeld(held: NativeChatMessage[]) {
  return renderHook<ReturnType<typeof useNativeChatAssembledMessages>, Props>(
    ({ baseMessages, appended }: Props) =>
      useNativeChatAssembledMessages({ agent: 'claude', sessionId: 's1', baseMessages, appended }),
    { initialProps: { baseMessages: held, appended: [] } }
  )
}

// #45168: a changed re-sent latest window kept the paged-in rows but re-merged all of them.
it('re-merges only the re-sent window when it joins the held history', () => {
  const held = rows(0, 2000)
  const view = mountHeld(held)
  merges.count = 0

  view.rerender({
    baseMessages: [...held.slice(0, 1700), ...rows(1700, 1999), row(1999, 'rewritten')],
    appended: []
  })

  expect(merges.count).toBe(300)
  const assembled = view.result.current.assembledMessages
  expect(assembled).toHaveLength(2000)
  expect(assembled[0]).toBe(held[0])
  expect(assembled[1999]!.blocks).toEqual([{ type: 'text', text: 'rewritten' }])
  view.unmount()
})

it('re-merges only the re-sent window after the live tail repeated held rows', () => {
  const held = rows(0, 2000)
  const view = mountHeld(held)
  // The live tail starts as the last window, so an append repeats held rows before the new one.
  view.rerender({ baseMessages: held, appended: [...held.slice(1700), row(2000)] })
  merges.count = 0

  view.rerender({
    baseMessages: [...held.slice(0, 1700), ...rows(1700, 2000), row(2000, 'rewritten')],
    appended: []
  })

  expect(merges.count).toBe(301)
  const assembled = view.result.current.assembledMessages
  expect(assembled).toHaveLength(2001)
  expect(assembled[0]).toBe(held[0])
  expect(assembled[2000]!.blocks).toEqual([{ type: 'text', text: 'rewritten' }])
  view.unmount()
})
