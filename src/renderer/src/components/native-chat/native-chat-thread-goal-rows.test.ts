import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { omitNativeChatThreadGoalRows } from './native-chat-thread-goal-rows'

const PAYLOAD = { head: '{}', byteLength: 2, digest: 'd'.repeat(64), truncated: false }

function frameRow(id: string, provider: string, kind: string): NativeChatMessage {
  return {
    id,
    role: 'system',
    timestamp: 0,
    source: 'transcript',
    blocks: [{ type: 'text', text: id, providerFrame: { provider, kind, payload: PAYLOAD } }]
  }
}

describe('omitNativeChatThreadGoalRows', () => {
  it('keeps a same-named frame from another provider', () => {
    const other = frameRow('other', 'claude', 'notification:thread/goal/updated')
    expect(omitNativeChatThreadGoalRows([other])).toEqual([other])
  })
})
