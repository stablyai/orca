// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendCommandMarkerCache,
  clearCommandMarkerCacheForTests
} from './native-chat-command-markers'
import { createNativeChatTranscriptOrder } from './native-chat-transcript-order'
import { useNativeChatCommandMarkers } from './use-native-chat-command-markers'

describe('useNativeChatCommandMarkers', () => {
  let root: Root | null = null
  const renders: { sessionId: string; markerIds: string[] }[] = []
  const resetWorkingInterrupt = vi.fn()

  function Probe({ sessionId }: { sessionId: string }): null {
    const { commandMarkers } = useNativeChatCommandMarkers({
      paneKey: 'tab:leaf',
      agent: 'claude',
      sessionId,
      messages: [],
      transcriptOrder: createNativeChatTranscriptOrder(1),
      onWorkingInterruptReset: resetWorkingInterrupt
    })
    renders.push({ sessionId, markerIds: commandMarkers.map((marker) => marker.id) })
    return null
  }

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    renders.length = 0
    clearCommandMarkerCacheForTests()
    resetWorkingInterrupt.mockClear()
  })

  it('drops the old clear boundary on the first replacement-session render', async () => {
    appendCommandMarkerCache(
      { paneKey: 'tab:leaf', agent: 'claude', sessionId: 'old-session' },
      '/clear',
      10,
      {
        clearAfterMessageId: null,
        clearTranscriptGeneration: 1,
        clearTranscriptHighWater: 0
      }
    )
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(createElement(Probe, { sessionId: 'old-session' })))
    const replacementStart = renders.length

    await act(async () => root?.render(createElement(Probe, { sessionId: 'new-session' })))

    expect(renders[replacementStart]).toEqual({ sessionId: 'new-session', markerIds: [] })
  })
})
