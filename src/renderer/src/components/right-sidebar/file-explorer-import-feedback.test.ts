import { describe, expect, it } from 'vitest'
import { getFileExplorerImportFailureToast } from './file-explorer-import-feedback'

describe('getFileExplorerImportFailureToast', () => {
  it('shows the actionable reason for a single failed import', () => {
    expect(
      getFileExplorerImportFailureToast([{ reason: 'File exceeds the 25 MB remote import limit' }])
    ).toEqual({
      title: 'Failed to import 1 file.',
      description: 'File exceeds the 25 MB remote import limit'
    })
  })

  it('deduplicates repeated reasons for a multi-file failure', () => {
    expect(
      getFileExplorerImportFailureToast([
        { reason: 'Permission denied' },
        { reason: ' Permission denied ' },
        { reason: 'Disk full' }
      ])
    ).toEqual({
      title: 'Failed to import 3 files.',
      description: 'Permission denied\nDisk full'
    })
  })

  it('omits an empty description while preserving the failure count', () => {
    expect(getFileExplorerImportFailureToast([{ reason: '  ' }])).toEqual({
      title: 'Failed to import 1 file.'
    })
  })

  it('caps distinct reasons and marks the truncation', () => {
    const failed = Array.from({ length: 7 }, (_, i) => ({
      reason: `EACCES: permission denied, open '/dest/file-${i}.txt'`
    }))
    const toast = getFileExplorerImportFailureToast(failed)
    expect(toast.title).toBe('Failed to import 7 files.')
    expect(toast.description?.split('\n')).toHaveLength(6)
    expect(toast.description?.split('\n').slice(0, 5)).toEqual(
      failed.slice(0, 5).map((f) => f.reason)
    )
    expect(toast.description?.endsWith('\n…')).toBe(true)
  })
})
