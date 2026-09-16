import { describe, expect, it } from 'vitest'
import { collectComposerDropResult, type ComposerDropItemResult } from './composer-drop-result'

describe('composer drop result', () => {
  it('separates imported files and folders while summarizing failures', () => {
    const results: ComposerDropItemResult[] = [
      { status: 'imported', kind: 'file', destPath: '/repo/.orca/drops/file.txt' },
      { status: 'imported', kind: 'directory', destPath: '/repo/.orca/drops/folder' },
      { status: 'skipped', reason: 'permission-denied' },
      { status: 'failed', reason: 'disk full' }
    ]

    expect(collectComposerDropResult(results)).toEqual({
      filePaths: ['/repo/.orca/drops/file.txt'],
      folderPaths: ['/repo/.orca/drops/folder'],
      failureCount: 2,
      commonFailure: undefined
    })
  })

  it('keeps a failure only when it explains the whole failed subset', () => {
    expect(
      collectComposerDropResult([
        { status: 'skipped', reason: 'missing' },
        { status: 'skipped', reason: 'missing' }
      ]).commonFailure
    ).toEqual({ status: 'skipped', reason: 'missing' })

    expect(
      collectComposerDropResult([
        { status: 'imported', kind: 'file', destPath: '/repo/.orca/drops/file.txt' }
      ]).commonFailure
    ).toBeUndefined()
  })
})
