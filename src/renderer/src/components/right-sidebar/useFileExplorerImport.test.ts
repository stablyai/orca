import { describe, expect, it } from 'vitest'
import {
  formatFileExplorerImportFailure,
  formatFileExplorerImportSkipped
} from './useFileExplorerImport'

describe('localized file explorer import copy', () => {
  it('uses complete singular and plural failure sentences', () => {
    expect(formatFileExplorerImportFailure(1)).toBe('Failed to import 1 file.')
    expect(formatFileExplorerImportFailure(3)).toBe('Failed to import 3 files.')
  })

  it('uses complete singular and plural skipped sentences', () => {
    expect(formatFileExplorerImportSkipped(1)).toBe('Skipped 1 file.')
    expect(formatFileExplorerImportSkipped(3)).toBe('Skipped 3 files.')
  })
})
