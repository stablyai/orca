import { describe, expect, it } from 'vitest'
import {
  collectComposerDropUploadResult,
  shouldReportComposerDropUploadFailure,
  type ComposerDropUploadImportResult
} from './composer-drop-upload-result'

describe('composer drop upload result', () => {
  it('separates imported files and folders while counting skipped or failed paths', () => {
    const results: ComposerDropUploadImportResult[] = [
      { status: 'imported', kind: 'file', destPath: '/repo/.orca/drops/file.txt' },
      { status: 'imported', kind: 'directory', destPath: '/repo/.orca/drops/folder' },
      { status: 'skipped' },
      { status: 'failed' }
    ]

    expect(collectComposerDropUploadResult(results)).toEqual({
      filePaths: ['/repo/.orca/drops/file.txt'],
      folderPaths: ['/repo/.orca/drops/folder'],
      skippedOrFailed: 2
    })
  })

  it('suppresses failed-upload reporting after a composer loses drop ownership', () => {
    const uploadResult = { skippedOrFailed: 1 }

    expect(shouldReportComposerDropUploadFailure(uploadResult, () => true)).toBe(true)
    expect(shouldReportComposerDropUploadFailure(uploadResult, () => false)).toBe(false)
    expect(shouldReportComposerDropUploadFailure({ skippedOrFailed: 0 }, () => true)).toBe(false)
  })
})
