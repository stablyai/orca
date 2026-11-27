import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeSharedDropFailureReason } from './drop-skip-reason-copy'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('describeSharedDropFailureReason', () => {
  it('names the shared category when host reasons differ only by file name and size', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      describeSharedDropFailureReason([
        {
          status: 'failed',
          reason: "'a.bin' is 120 MB, over the 100 MB per-file remote import limit"
        },
        {
          status: 'failed',
          reason: "'b.iso' is 4.2 GB, over the 100 MB per-file remote import limit"
        }
      ])
    ).toBe('Too large to upload to this host.')
  })
})
