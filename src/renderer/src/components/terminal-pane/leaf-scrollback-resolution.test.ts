import { describe, expect, it } from 'vitest'
import { resolveLeafScrollbackBuffers } from './leaf-scrollback-resolution'

describe('resolveLeafScrollbackBuffers', () => {
  it('returns the shared layout buffers when nothing is held locally', () => {
    const shared = { buffersByLeafId: { 'leaf-1': 'shared' } }
    expect(resolveLeafScrollbackBuffers({ shared, localOnly: undefined })).toBe(
      shared.buffersByLeafId
    )
    expect(resolveLeafScrollbackBuffers({ shared, localOnly: {} })).toBe(shared.buffersByLeafId)
  })

  it('returns the local-only buffers when the shared layout holds none', () => {
    const localOnly = { 'leaf-1': 'local' }
    expect(resolveLeafScrollbackBuffers({ shared: undefined, localOnly })).toBe(localOnly)
    expect(resolveLeafScrollbackBuffers({ shared: {}, localOnly })).toBe(localOnly)
  })

  it('lets the local-only copy win a leaf both homes hold, and unions the rest', () => {
    expect(
      resolveLeafScrollbackBuffers({
        shared: { buffersByLeafId: { 'leaf-1': 'shared-stale', 'leaf-2': 'shared-only' } },
        localOnly: { 'leaf-1': 'local-newer', 'leaf-3': 'local-only' }
      })
    ).toEqual({ 'leaf-1': 'local-newer', 'leaf-2': 'shared-only', 'leaf-3': 'local-only' })
  })

  it('returns undefined when neither home holds anything', () => {
    expect(
      resolveLeafScrollbackBuffers({ shared: undefined, localOnly: undefined })
    ).toBeUndefined()
  })
})
