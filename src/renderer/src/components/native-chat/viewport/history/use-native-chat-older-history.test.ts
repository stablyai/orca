// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { ReadState } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatSessionTransport } from '../../session/terminal/read/native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from '../../session/terminal/read/use-native-chat-transcript-lifecycle'
import { useNativeChatOlderHistory } from './use-native-chat-older-history'

const row = (index: number): NativeChatMessage => ({
  id: `row-${index}`,
  role: index % 2 ? 'assistant' : 'user',
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: `Row ${index}` }]
})

it('counts a reread page once, however often its callback is called', async () => {
  const loaded = Array.from({ length: 300 }, (_, index) => row(index + 100))
  // The transcript holds 100 more rows, so the first reread grows the window and later ones don't.
  const whole = [...Array.from({ length: 100 }, (_, index) => row(index)), ...loaded]
  const transport: NativeChatSessionTransport = {
    readSession: async () => ({ messages: whole }),
    subscribe: () => () => {}
  }
  const refs = {
    liveTailRef: { current: { list: [] } },
    limitRef: { current: 300 },
    latestEnabled: { current: true },
    latestSessionId: { current: 's' },
    latestTransport: { current: transport },
    transcriptEpochRef: { current: 0 }
  }
  const { result } = renderHook(() => {
    const [read, setRead] = useState<ReadState>({ phase: 'ready', messages: loaded })
    const [, setLoadingEarlier] = useState(false)
    const [, setHasMore] = useState(true)
    const [, transcriptLifecycleControl] = useNativeChatTranscriptLifecycle()
    return useNativeChatOlderHistory({
      agent: 'claude',
      sessionId: 's',
      transcriptPath: null,
      transport,
      hasMore: true,
      // The read this callback was made with: a retained callback keeps seeing it.
      read,
      olderHistoryGeneration: 0,
      transcriptLifecycleControl,
      setLoadingEarlier,
      setRead,
      setHasMore,
      ...refs
    })
  })
  const retained = result.current.loadEarlier
  await act(async () => {
    expect(await retained()).toBe('applied')
  })
  await act(async () => {
    expect(await retained()).not.toBe('applied')
  })
  expect(result.current.olderPages).toBe(1)
})
