import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatGalleryIndex } from './native-chat-gallery-index'
import {
  nativeChatGallerySlotSurfaces,
  nativeChatReasoningImageSurface
} from './native-chat-gallery-surfaces'
import type { NativeChatGallerySurface } from './native-chat-gallery-surfaces'

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
function surfaces(message: NativeChatMessage, workRun?: NativeChatMessage[]) {
  return nativeChatGallerySlotSurfaces(
    {
      message,
      workRun,
      drawsMessage: true,
      receipt: false,
      activeTurnIsWorking: false,
      trailingRun: false
    },
    { visuals: false, stoppedLabel: '' }
  )
}
async function put(
  index: NativeChatGalleryIndex,
  revision: number,
  handle: number,
  value: NativeChatGallerySurface[]
) {
  const result = await index.handle({
    type: 'put',
    id: handle,
    revision,
    groups: [{ handle, surfaces: value, projectionMs: 0 }]
  })
  if (result.type !== 'groups') {
    throw new Error('Image group did not index')
  }
  return result.groups[0]!.entries
}

describe('transcript gallery index', () => {
  it('distinguishes attachment and document actions at the same source', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({ type: 'begin', scopeKey: 'test-chat', id: 1, revision: 1 })
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
    const entries = await put(index, 1, 2, surfaces(message))
    expect(
      entries.map(({ ownerId, role, kind, source }) => ({ ownerId, role, kind, source }))
    ).toEqual([
      { ownerId: 'user', role: 'row-attachment', kind: 'file', source: 'same.png' },
      { ownerId: 'user', role: 'row-document', kind: 'document', source: 'same.png' }
    ])
  })

  it('keeps selected reasoning when it moves into a grouped run after the read previews', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({ type: 'begin', scopeKey: 'test-chat', id: 1, revision: 1 })
    const first = await put(index, 1, 2, [nativeChatReasoningImageSurface(thought)])
    await index.handle({ type: 'commit', id: 3, revision: 1 })
    const selected = first[0]!.key
    await index.handle({ type: 'begin', scopeKey: 'test-chat', id: 4, revision: 2 })
    const second = await put(index, 2, 5, surfaces(thought, [thought, read]))
    expect(second.map(({ ownerId, source }) => ({ ownerId, source }))).toEqual([
      { ownerId: 'read', source: '/tmp/read.png' },
      { ownerId: 'thought', source: 'thought.png' }
    ])
    expect(second.find((entry) => entry.key === selected)?.source).toBe('thought.png')
  })

  it('refuses a stale revision instead of publishing another transcript snapshot', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({ type: 'begin', scopeKey: 'test-chat', id: 1, revision: 2 })
    expect(await index.handle({ type: 'reuse', id: 2, revision: 1, handles: [1] })).toEqual({
      id: 2,
      revision: 1,
      type: 'superseded'
    })
  })

  it('cannot carry a selection into a different runtime with the same message and path', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({ type: 'begin', id: 1, revision: 1, scopeKey: 'chat:host-a' })
    const original = await put(index, 1, 2, surfaces(read))
    const selected = original[0]!.key
    await index.handle({ type: 'commit', id: 3, revision: 1 })
    await index.handle({ type: 'begin', id: 4, revision: 2, scopeKey: 'chat:host-b' })
    const next = await put(index, 2, 5, surfaces(read))
    expect(next.find((entry) => entry.key === selected)).toBeUndefined()
    expect(next.map((entry) => entry.source)).toEqual(['/tmp/read.png'])
  })

  it('retires a rewound group only after the client releases its lease', async () => {
    const index = new NativeChatGalleryIndex()
    await index.handle({ type: 'begin', id: 1, revision: 1, scopeKey: 'chat' })
    await put(index, 1, 2, surfaces(read))
    await index.handle({ type: 'commit', id: 3, revision: 1 })
    await index.handle({ type: 'begin', id: 4, revision: 2, scopeKey: 'chat' })
    await index.handle({ type: 'reuse', id: 5, revision: 2, handles: [2] })
    const reused = await index.handle({ type: 'commit', id: 6, revision: 2 })
    expect(reused).toMatchObject({ type: 'ready', order: [2] })
    await index.handle({ type: 'begin', id: 7, revision: 3, scopeKey: 'chat' })
    await index.handle({ type: 'commit', id: 8, revision: 3 })
    await index.handle({ type: 'begin', id: 9, revision: 4, scopeKey: 'chat' })
    expect(await index.handle({ type: 'reuse', id: 10, revision: 4, handles: [2] })).toMatchObject({
      type: 'ack'
    })
    await index.handle({ type: 'release', id: 11, revision: 4, handles: [2] })
    expect(await index.handle({ type: 'reuse', id: 10, revision: 4, handles: [2] })).toMatchObject({
      type: 'error'
    })
  })
})

it('keeps huge image fields exact while assigning bounded duplicate-safe renderer identities', async () => {
  const index = new NativeChatGalleryIndex()
  await index.handle({ type: 'begin', id: 1, revision: 1, scopeKey: 'chat' })
  const source = `data:image/png;base64,${'a'.repeat(500_000)}`
  const second = `${source}b`
  const result = await index.handle({
    type: 'put',
    id: 2,
    revision: 1,
    groups: [source, source, second].map((url, offset) => ({
      handle: offset + 10,
      projectionMs: 0,
      surfaces: [
        {
          kind: 'files' as const,
          ownerId: 'same',
          slotKey: 'same',
          role: 'row-attachment',
          blocks: [{ type: 'image-ref' as const, url }]
        }
      ]
    }))
  })
  if (result.type !== 'groups') {
    throw new Error('Large image identities did not index')
  }
  const entries = result.groups.flatMap((group) => group.entries)
  expect(entries.map((entry) => entry.key.length <= 64)).toEqual([true, true, true])
  expect(new Set(entries.map((entry) => entry.key)).size).toBe(2)
  expect(entries.map((entry) => entry.source)).toEqual([source, source, second])
})

it('preserves raw file-linked image actions and custody only for the enabled matching target', async () => {
  const document = (target: string, allowFileUriLinks: boolean): NativeChatGallerySurface[] => [
    {
      kind: 'document',
      ownerId: 'html',
      slotKey: 'html',
      role: 'row-document',
      growing: false,
      visuals: false,
      allowFileUriLinks,
      text: `<a href="${target}"><img src="https://example.com/image.png" alt="image"></a>`
    }
  ]
  const index = new NativeChatGalleryIndex()
  await index.handle({ type: 'begin', id: 1, revision: 1, scopeKey: 'chat' })
  const original = await put(index, 1, 10, document('file:///tmp/one.pdf', true))
  expect(
    original.map((entry) => (entry.kind === 'document' ? entry.linkedHref : undefined))
  ).toEqual(['file:///tmp/one.pdf'])
  const selected = original[0]!.key
  const restored = new NativeChatGalleryIndex()
  await restored.handle({ type: 'begin', id: 2, revision: 1, scopeKey: 'chat' })
  await restored.handle({ type: 'restore', id: 3, revision: 1, entries: original })
  const same = await put(restored, 1, 11, document('file:///tmp/one.pdf', true))
  expect(same.find((entry) => entry.key === selected)?.source).toBe('https://example.com/image.png')
  const different = await put(restored, 1, 12, document('file:///tmp/two.pdf', true))
  expect(different.find((entry) => entry.key === selected)).toBeUndefined()
  expect(
    different.map((entry) => (entry.kind === 'document' ? entry.linkedHref : undefined))
  ).toEqual(['file:///tmp/two.pdf'])
  await restored.handle({ type: 'begin', id: 4, revision: 2, scopeKey: 'chat' })
  const unavailable = await put(restored, 2, 13, document('file:///tmp/two.pdf', false))
  expect(
    unavailable.map((entry) => (entry.kind === 'document' ? entry.linkedHref : undefined))
  ).toEqual([undefined])
  expect(unavailable.map((entry) => entry.source)).toEqual(['https://example.com/image.png'])
})
