import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatGallerySlotSurfaces } from './native-chat-gallery-surfaces'
import { nativeChatGalleryEntries } from './native-chat-gallery-entries'

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

it('includes only the rendered plan document, with notice precedence over provider frames', () => {
  const plan: NativeChatMessage = {
    id: 'plan',
    role: 'system',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      { type: 'image-ref', path: '/tmp/not-rendered.png' },
      {
        type: 'text',
        presentation: 'plan-document',
        text: '![plan](/tmp/plan.png)',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:fixture',
          payload: { head: '', byteLength: 0, digest: '', truncated: false }
        }
      },
      { type: 'text', text: '![other](/tmp/other.png)' }
    ]
  }
  expect(
    surfaces(plan).flatMap((surface) =>
      nativeChatGalleryEntries('chat', surface).map(({ source, ownerId, role, slotKey }) => ({
        source,
        ownerId,
        role,
        slotKey
      }))
    )
  ).toEqual([{ source: '/tmp/plan.png', ownerId: 'plan', role: 'plan-document', slotKey: 'plan' }])
  expect(
    surfaces({
      ...plan,
      blocks: [{ type: 'text', presentation: 'command-output', text: '![plan](/tmp/plan.png)' }]
    })
  ).toEqual([])
  expect(
    surfaces({ ...plan, from: message.from, agentStart: true }).map((surface) => surface.role)
  ).toEqual(['agent-card-attachment', 'agent-card-document'])
})
