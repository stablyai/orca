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
})
