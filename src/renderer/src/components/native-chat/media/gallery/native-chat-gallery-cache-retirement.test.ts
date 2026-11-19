import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatGalleryIndex } from './native-chat-gallery-index'
import { NativeChatGalleryProjectionCache } from './native-chat-gallery-projection-cache'
import { nativeChatGallerySlotSurfaces } from './native-chat-gallery-surfaces'

const options = { visuals: false, stoppedLabel: '' }
function message(id: string, count: number): NativeChatMessage {
  return {
    id,
    role: 'user',
    timestamp: 1,
    source: 'transcript',
    blocks: Array.from({ length: count }, (_, index) => ({
      type: 'image-ref',
      path: `/tmp/${id}-${index}.png`
    }))
  }
}

it.each(['result-transfer', 'assembly'])(
  'restores a rewound image after cancellation during %s',
  async (boundary) => {
    const index = new NativeChatGalleryIndex()
    const cache = new NativeChatGalleryProjectionCache()
    const first = message('first', 128)
    const restored = message('restored', 1)
    const input = (row: NativeChatMessage) => ({
      key: `slot:${row.id}`,
      message: row,
      active: false,
      trailing: false
    })
    let id = 0
    const begin = (revision: number) =>
      index.handle({ type: 'begin', id: ++id, revision, scopeKey: 'chat' })
    const commit = async (revision: number) => {
      const result = await index.handle({ type: 'commit', id: ++id, revision })
      if (result.type !== 'ready') {
        throw new Error('Snapshot did not commit')
      }
      return result.order
    }
    const reuse = async (revision: number, handles: number[]) => {
      const result = await index.handle({ type: 'reuse', id: ++id, revision, handles })
      if (result.type !== 'ack') {
        throw new Error('Restored snapshot rejected a retained image')
      }
    }
    await begin(1)
    const prepared = [first, restored].map((row) =>
      cache.prepare(input(row), options, () =>
        nativeChatGallerySlotSurfaces(
          {
            message: row,
            drawsMessage: true,
            receipt: false,
            activeTurnIsWorking: false,
            trailingRun: false
          },
          options
        )
      )
    )
    const uploaded = await index.handle({
      type: 'put',
      id: ++id,
      revision: 1,
      groups: prepared.map(({ handle, surfaces, projectionMs }) => ({
        handle,
        surfaces,
        projectionMs
      }))
    })
    if (uploaded.type !== 'groups') {
      throw new Error('Images did not upload')
    }
    cache.register(prepared, uploaded.groups)
    const initial = await cache.assemble(await commit(1), () => true)
    const selected = initial?.find((entry) => entry.source === '/tmp/restored-0.png')?.key
    await begin(2)
    await reuse(2, [prepared[0]!.handle])
    const rewind = await commit(2)
    if (boundary === 'assembly') {
      expect(await cache.assemble(rewind, () => false)).toBeNull()
    }
    await begin(3)
    const handle = await cache.cached(input(restored), options)
    if (handle === null) {
      throw new Error('Restored image was prematurely retired')
    }
    await reuse(3, [prepared[0]!.handle, handle])
    const result = await cache.assemble(await commit(3), () => true)
    expect(result?.length).toBe(129)
    expect(result?.find((entry) => entry.key === selected)?.source).toBe('/tmp/restored-0.png')
  }
)
