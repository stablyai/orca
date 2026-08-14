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
  it('holds only the latest settled transcript for the same identity while unsettled', () => {
    const retention = createNativeChatTranscriptRetention()
    const first = [message('first')]
    const second = [message('second')]

    retention.capture('source-a', first)
    expect(retention.visible({ identity: 'source-a', messages: [], settled: false })).toBe(first)
    expect(retention.visible({ identity: 'source-b', messages: [], settled: false })).toEqual([])

    retention.capture('source-b', second)
    expect(retention.visible({ identity: 'source-a', messages: [], settled: false })).toEqual([])
    expect(retention.visible({ identity: 'source-b', messages: [], settled: false })).toBe(second)
  })

  it('never substitutes retained history for a settled read', () => {
    const retention = createNativeChatTranscriptRetention()
    const retained = [message('retained')]
    const fresh = [message('fresh')]
    retention.capture('source', retained)

    expect(retention.visible({ identity: 'source', messages: fresh, settled: true })).toBe(fresh)
  })

  it('encodes identity components without delimiter collisions', () => {
    expect(encodeNativeChatTranscriptIdentity(['host\0workspace', 'session'])).not.toBe(
      encodeNativeChatTranscriptIdentity(['host', 'workspace\0session'])
    )
  })
})
