import { describe, expect, it, vi } from 'vitest'
import { LocalImageBlobRetention, MAX_LOCAL_IMAGE_BLOB_BYTES } from './local-image-blob-retention'

describe('LocalImageBlobRetention', () => {
  it('evicts oldest blobs until aggregate retained bytes are bounded', () => {
    const revoke = vi.fn()
    const retention = new LocalImageBlobRetention(revoke)

    retention.set('first', { url: 'blob:first', bytes: MAX_LOCAL_IMAGE_BLOB_BYTES - 1 })
    retention.set('second', { url: 'blob:second', bytes: 2 })

    expect(retention.has('first')).toBe(false)
    expect(retention.get('second')).toBe('blob:second')
    expect(retention.retainedBytes).toBe(2)
    expect(revoke).toHaveBeenCalledWith('blob:first')
  })
})
