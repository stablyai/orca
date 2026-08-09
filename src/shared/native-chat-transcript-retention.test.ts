import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  createNativeChatTranscriptRetention,
  encodeNativeChatTranscriptIdentity
} from './native-chat-transcript-retention'

function message(id: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [], timestamp: 0, source: 'transcript' }
}

describe('native chat transcript retention', () => {
  it('holds only the latest settled transcript for the same identity while loading', () => {
    const retention = createNativeChatTranscriptRetention()
    const first = [message('first')]
    const second = [message('second')]

    retention.capture('source-a', first)
    expect(
      retention.visible({ identity: 'source-a', messages: [], settled: false, loading: true })
    ).toBe(first)
    expect(
      retention.visible({ identity: 'source-b', messages: [], settled: false, loading: true })
    ).toEqual([])

    retention.capture('source-b', second)
    expect(
      retention.visible({ identity: 'source-a', messages: [], settled: false, loading: true })
    ).toEqual([])
    expect(
      retention.visible({ identity: 'source-b', messages: [], settled: false, loading: true })
    ).toBe(second)
  })

  it('never substitutes retained history for a settled or non-loading read', () => {
    const retention = createNativeChatTranscriptRetention()
    const retained = [message('retained')]
    const fresh = [message('fresh')]
    retention.capture('source', retained)

    expect(
      retention.visible({ identity: 'source', messages: fresh, settled: true, loading: false })
    ).toBe(fresh)
    expect(
      retention.visible({ identity: 'source', messages: [], settled: false, loading: false })
    ).toEqual([])
  })

  it('encodes identity components without delimiter collisions', () => {
    expect(encodeNativeChatTranscriptIdentity(['host\0workspace', 'session'])).not.toBe(
      encodeNativeChatTranscriptIdentity(['host', 'workspace\0session'])
    )
  })
})
