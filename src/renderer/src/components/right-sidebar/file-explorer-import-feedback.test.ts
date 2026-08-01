import { describe, expect, it } from 'vitest'
import { getFileExplorerImportFailureToast } from './file-explorer-import-feedback'

describe('getFileExplorerImportFailureToast', () => {
  it('shows the actionable reason for a single failed import', () => {
    expect(
      getFileExplorerImportFailureToast([
        { reason: "'large.bin' exceeds the 25 MB remote import limit" }
      ])
    ).toEqual({
      title: 'Failed to import 1 file.',
      description: "'large.bin' exceeds the 25 MB remote import limit"
    })
  })

  it('collapses newlines inside a reason to keep one line per reason', () => {
    expect(
      getFileExplorerImportFailureToast([
        { reason: "'a\nfake status line.bin' exceeds the 25 MB remote import limit" },
        { reason: "'a fake status line.bin' exceeds the 25 MB remote import limit" }
      ])
    ).toEqual({
      title: 'Failed to import 2 files.',
      description: "'a fake status line.bin' exceeds the 25 MB remote import limit"
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
    expect(getFileExplorerImportFailureToast([{ reason: '  ' }])).toStrictEqual({
      title: 'Failed to import 1 file.'
    })
  })

  it('dedupes before applying the cap', () => {
    const failed = Array.from({ length: 7 }, (_, i) => ({ reason: `r-${i % 3}` }))
    expect(getFileExplorerImportFailureToast(failed)).toStrictEqual({
      title: 'Failed to import 7 files.',
      description: 'r-0\nr-1\nr-2'
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

  it('never truncates when the ellipsis would not save a line', () => {
    const reasonsOf = (count: number) =>
      getFileExplorerImportFailureToast(
        Array.from({ length: count }, (_, i) => ({ reason: `r-${i}` }))
      ).description?.split('\n')
    expect(reasonsOf(5)).toHaveLength(5)
    expect(reasonsOf(5)).not.toContain('…')
    expect(reasonsOf(6)).toHaveLength(6)
    expect(reasonsOf(6)).not.toContain('…')
  })
})
