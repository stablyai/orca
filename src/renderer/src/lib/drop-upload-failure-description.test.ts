import { describe, expect, it } from 'vitest'
import { formatDropUploadFailureDescription } from './drop-upload-failure-description'

describe('formatDropUploadFailureDescription', () => {
  it('shows the filename and reason without exposing the source path', () => {
    expect(
      formatDropUploadFailureDescription([
        { sourcePath: '/secret/project/file.txt', reason: 'File is too large' }
      ])
    ).toBe('file.txt: File is too large')
  })

  it('limits long failure lists while preserving the remaining count', () => {
    expect(
      formatDropUploadFailureDescription([
        { sourcePath: '/tmp/one.txt', reason: 'disk full' },
        { sourcePath: '/tmp/two.txt', reason: 'permission denied' },
        { sourcePath: '/tmp/three.txt', reason: 'timed out' }
      ])
    ).toBe('one.txt: Not enough storage.\ntwo.txt: Permission denied.\n+1 more failure')
  })

  it('uses the plural form for multiple hidden failures', () => {
    expect(
      formatDropUploadFailureDescription([
        { sourcePath: '/tmp/one.txt', reason: 'disk full' },
        { sourcePath: '/tmp/two.txt', reason: 'permission denied' },
        { sourcePath: '/tmp/three.txt', reason: 'timed out' },
        { sourcePath: '/tmp/four.txt', reason: 'unsupported' }
      ])
    ).toBe('one.txt: Not enough storage.\ntwo.txt: Permission denied.\n+2 more failures')
  })

  it('maps known reasons and hides unknown technical details', () => {
    expect(
      formatDropUploadFailureDescription([
        { sourcePath: '/tmp/large.txt', reason: 'File is too large' },
        { sourcePath: '/tmp/private.txt', reason: 'EACCES /Users/me/private.txt token=secret' }
      ])
    ).toBe('large.txt: File is too large\nprivate.txt: Upload failed.')
  })

  it('maps dynamic remote budget errors without exposing their details', () => {
    expect(
      formatDropUploadFailureDescription([
        {
          sourcePath: '/tmp/large.txt',
          reason: "'clip.mp4' is 3 MB, over the 2 MB per-file remote import limit"
        },
        {
          sourcePath: '/tmp/drop',
          reason: 'This import is 9 GB, over the 8 GB total remote import limit'
        }
      ])
    ).toBe('large.txt: File is too large\ndrop: Total upload is too large.')
  })
})
