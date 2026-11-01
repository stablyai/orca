// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { useNativeChatSubagentPage } from './use-native-chat-subagent-page'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('useNativeChatSubagentPage', () => {
  it('hides rows while the child read is in flight, then drops them when focus clears', async () => {
    let finish: (value: {
      messages: NativeChatMessage[]
      hasMore: boolean
      beforeOffset: number
    }) => void = () => {}
    const readPage = vi.fn(
      () =>
        new Promise<{ messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }>(
          (resolve) => {
            finish = resolve
          }
        )
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNativeChatSubagentPage(id, readPage),
      { initialProps: { id: 'child' as string | null } }
    )
    expect(result.current.loading).toBe(true)
    expect(result.current.messages).toEqual([])
    await act(async () => {
      finish({ messages: [message('child:1')], hasMore: false, beforeOffset: 4 })
    })
    await waitFor(() =>
      expect(result.current.messages?.map((entry) => entry.id)).toEqual(['child:1'])
    )
    expect(result.current.loading).toBe(false)
    rerender({ id: null })
    expect(result.current.messages).toBeNull()
    expect(result.current.loading).toBe(false)
  })
})
