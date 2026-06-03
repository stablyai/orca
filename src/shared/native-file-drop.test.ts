import { describe, expect, it } from 'vitest'
import {
  NATIVE_FILE_DROP_TARGET,
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  hasNativeFileDragTypes,
  resolveNativeFileDropPath
} from './native-file-drop'

describe('hasNativeFileDragTypes', () => {
  it('accepts native OS file drags', () => {
    expect(hasNativeFileDragTypes(['Files'])).toBe(true)
  })

  it('rejects internal Orca file moves and URL/text drags', () => {
    expect(hasNativeFileDragTypes(['Files', ORCA_INTERNAL_FILE_DRAG_TYPE])).toBe(false)
    expect(hasNativeFileDragTypes(['text/uri-list'])).toBe(false)
    expect(hasNativeFileDragTypes(['text/plain'])).toBe(false)
  })
})

describe('resolveNativeFileDropPath', () => {
  it('routes drops on the project sidebar to the add-project surface', () => {
    expect(
      resolveNativeFileDropPath([{ nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.projectSidebar }])
    ).toEqual({ target: NATIVE_FILE_DROP_TARGET.projectSidebar })
  })

  it('preserves terminal tab routing for native file drops', () => {
    expect(
      resolveNativeFileDropPath([
        {
          nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.terminal,
          terminalTabId: 'tab-1'
        }
      ])
    ).toEqual({ target: NATIVE_FILE_DROP_TARGET.terminal, tabId: 'tab-1' })
  })

  it('uses the nearest file-explorer destination and fails closed without one', () => {
    expect(
      resolveNativeFileDropPath([
        { nativeFileDropDir: '/repo/src' },
        {
          nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.fileExplorer,
          nativeFileDropDir: '/repo'
        }
      ])
    ).toEqual({
      target: NATIVE_FILE_DROP_TARGET.fileExplorer,
      destinationDir: '/repo/src'
    })

    expect(
      resolveNativeFileDropPath([{ nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.fileExplorer }])
    ).toEqual({ target: 'rejected' })
  })
})
