import { describe, expect, it } from 'vitest'
import { explorerActiveFileId } from './file-explorer-active-file'

describe('explorerActiveFileId', () => {
  it('exposes the active editor file while following is on or unset', () => {
    expect(
      explorerActiveFileId({
        settings: { fileExplorerFollowsActiveFile: true },
        activeFileId: 'f1'
      })
    ).toBe('f1')
    expect(explorerActiveFileId({ settings: null, activeFileId: 'f1' })).toBe('f1')
  })

  it('hides the active editor file from the explorer when following is off (#35887)', () => {
    expect(
      explorerActiveFileId({
        settings: { fileExplorerFollowsActiveFile: false },
        activeFileId: 'f1'
      })
    ).toBeNull()
  })
})
