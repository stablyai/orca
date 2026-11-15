import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatGallerySlotSurfaces } from './native-chat-gallery-surfaces'

const message: NativeChatMessage = {
  id: 'agent-frame',
  role: 'user',
  timestamp: 1,
  source: 'transcript',
  from: { kind: 'agent', senders: [], orchestration: null },
  blocks: [
    { type: 'image-ref', path: '/tmp/hidden.png' },
    {
      type: 'text',
      text: '![hidden](hidden.png)',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:fixture',
        payload: { head: '', byteLength: 0, digest: '', truncated: false }
      }
    }
  ]
}
function surfaces(input: NativeChatMessage) {
  return nativeChatGallerySlotSurfaces(
    {
      message: input,
      drawsMessage: true,
      receipt: false,
      activeTurnIsWorking: false,
      trailingRun: false
    },
    { stoppedLabel: '', visuals: false }
  )
}

describe('gallery provider-frame precedence', () => {
  it('does not invent card images for an agent-origin user provider frame', () => {
    expect(surfaces(message)).toEqual([])
  })
  it('retains the renderer precedence of an explicit agent-start card', () => {
    expect(
      surfaces({ ...message, agentStart: true }).map(({ kind, role }) => ({ kind, role }))
    ).toEqual([
      { kind: 'files', role: 'agent-card-attachment' },
      { kind: 'document', role: 'agent-card-document' }
    ])
  })
})
