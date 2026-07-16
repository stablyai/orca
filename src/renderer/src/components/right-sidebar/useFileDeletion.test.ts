import { describe, expect, it } from 'vitest'
import {
  formatFileDeletionFailure,
  formatMixedFileDeletionDescription
} from './file-deletion-localized-copy'

describe('localized file deletion copy', () => {
  it('formats complete remote, Windows, and macOS/Linux failure sentences', () => {
    expect(formatFileDeletionFailure({ name: 'a.ts', isRemote: true, isWindows: false })).toBe(
      "Failed to delete 'a.ts'."
    )
    expect(formatFileDeletionFailure({ name: 'a.ts', isRemote: false, isWindows: true })).toBe(
      "Failed to move 'a.ts' to the Recycle Bin."
    )
    expect(formatFileDeletionFailure({ name: 'a.ts', isRemote: false, isWindows: false })).toBe(
      "Failed to move 'a.ts' to the Trash."
    )
  })

  it('keeps platform trash names inside their full batch descriptions', () => {
    expect(formatMixedFileDeletionDescription(true)).toBe(
      'Remote items are permanently deleted and cannot be undone. Local items move to the Recycle Bin.'
    )
    expect(formatMixedFileDeletionDescription(false)).toBe(
      'Remote items are permanently deleted and cannot be undone. Local items move to the Trash.'
    )
  })
})
