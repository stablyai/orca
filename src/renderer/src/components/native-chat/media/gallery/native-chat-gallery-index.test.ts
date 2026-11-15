import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatGalleryIndex } from './native-chat-gallery-index'
import type { NativeChatGallerySlot } from './native-chat-gallery-surfaces'

function slot(message: NativeChatMessage, workRun?: NativeChatMessage[]): NativeChatGallerySlot {
  return {
    message,
    workRun,
    drawsMessage: true,
    receipt: false,
    activeTurnIsWorking: false,
    trailingRun: false
  }
}

const thought: NativeChatMessage = {
  id: 'thought',
  role: 'reasoning',
  timestamp: 2,
  source: 'transcript',
  blocks: [{ type: 'text', text: '![thought](thought.png)' }]
}
const read: NativeChatMessage = {
  id: 'read',
  role: 'assistant',
  timestamp: 3,
  source: 'transcript',
  blocks: [
    {
      type: 'tool-call',
      name: 'Read',
      input: { file_path: '/tmp/read.png' },
      callId: 'read-1',
      state: 'completed'
    },
    { type: 'tool-result', callId: 'read-1', output: 'image bytes are not needed by the index' }
  ]
}

describe('transcript gallery index', () => {
  it('distinguishes attachment and document actions at the same source and skips undrawn slots', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({
      type: 'begin',
      scopeKey: 'test-chat',
      id: 1,
      revision: 1,
      visuals: false,
      stoppedLabel: ''
    })
    const message: NativeChatMessage = {
      id: 'user',
      role: 'user',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        { type: 'image-ref', path: 'same.png' },
        { type: 'text', text: '![document](same.png)' }
      ]
    }
    await index.handle({ type: 'slot', id: 2, revision: 1, slot: slot(message) })
    await index.handle({
      type: 'slot',
      id: 3,
      revision: 1,
      slot: { ...slot(thought), drawsMessage: false }
    })
    await index.handle({ type: 'slot', id: 4, revision: 1, slot: { ...slot(read), receipt: true } })
    const result = await index.handle({ type: 'commit', id: 5, revision: 1 })
    expect(result.type).toBe('ready')
    if (result.type !== 'ready') {
      throw new Error('Index did not commit')
    }
    expect(
      result.entries.map(({ ownerId, role, kind, source }) => ({ ownerId, role, kind, source }))
    ).toEqual([
      { ownerId: 'user', role: 'row-attachment', kind: 'file', source: 'same.png' },
      { ownerId: 'user', role: 'row-document', kind: 'document', source: 'same.png' }
    ])
  })

  it('keeps selected reasoning when it moves into a grouped run, after the run read previews', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({
      type: 'begin',
      scopeKey: 'test-chat',
      id: 1,
      revision: 1,
      visuals: false,
      stoppedLabel: ''
    })
    await index.handle({ type: 'reasoning', id: 2, revision: 1, message: thought, growing: false })
    const first = await index.handle({ type: 'commit', id: 3, revision: 1 })
    if (first.type !== 'ready') {
      throw new Error('Initial image index did not commit')
    }
    const selected = first.entries[0]!.key
    await index.handle({
      type: 'begin',
      scopeKey: 'test-chat',
      id: 4,
      revision: 2,
      visuals: false,
      stoppedLabel: ''
    })
    await index.handle({ type: 'slot', id: 5, revision: 2, slot: slot(thought, [thought, read]) })
    const second = await index.handle({ type: 'commit', id: 6, revision: 2 })
    if (second.type !== 'ready') {
      throw new Error('Updated image index did not commit')
    }
    expect(second.entries.map(({ ownerId, source }) => ({ ownerId, source }))).toEqual([
      { ownerId: 'read', source: '/tmp/read.png' },
      { ownerId: 'thought', source: 'thought.png' }
    ])
    expect(second.entries.find((entry) => entry.key === selected)?.source).toBe('thought.png')
  })

  it('refuses a stale revision instead of publishing another transcript snapshot', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({
      type: 'begin',
      scopeKey: 'test-chat',
      id: 1,
      revision: 2,
      visuals: false,
      stoppedLabel: ''
    })
    const result = await index.handle({ type: 'slot', id: 2, revision: 1, slot: slot(thought) })
    expect(result).toEqual({
      id: 2,
      revision: 1,
      type: 'superseded'
    })
  })

  it('cannot carry a selection into a different runtime with the same message and path', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({
      type: 'begin',
      id: 1,
      revision: 1,
      scopeKey: 'chat:host-a',
      visuals: false,
      stoppedLabel: ''
    })
    await index.handle({ type: 'slot', id: 2, revision: 1, slot: slot(read) })
    const original = await index.handle({ type: 'commit', id: 3, revision: 1 })
    if (original.type !== 'ready') {
      throw new Error('Original image index did not commit')
    }
    const selected = original.entries[0]!.key
    await index.handle({
      type: 'begin',
      id: 4,
      revision: 2,
      scopeKey: 'chat:host-b',
      visuals: false,
      stoppedLabel: ''
    })
    await index.handle({ type: 'slot', id: 5, revision: 2, slot: slot(read) })
    const next = await index.handle({ type: 'commit', id: 6, revision: 2 })
    if (next.type !== 'ready') {
      throw new Error('New runtime image index did not commit')
    }
    expect(next.entries.find((entry) => entry.key === selected)).toBeUndefined()
    expect(next.entries.map((entry) => entry.source)).toEqual(['/tmp/read.png'])
  })
})
