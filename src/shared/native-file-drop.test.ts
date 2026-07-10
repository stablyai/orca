import { describe, expect, it } from 'vitest'
import {
  NATIVE_FILE_DROP_MAX_PATH_BYTES,
  NATIVE_FILE_DROP_MAX_PATHS,
  NATIVE_FILE_DROP_TARGET,
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  createNativeFileDropPayload,
  createRejectedNativeFileDropPayload,
  hasNativeFileDragTypes,
  isNativeFileDropPayload,
  validateNativeFileDropPaths,
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
  it('routes drops on the left sidebar to the add-project surface', () => {
    expect(
      resolveNativeFileDropPath([{ nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.projectSidebar }])
    ).toEqual({ target: NATIVE_FILE_DROP_TARGET.projectSidebar })
  })

  it('preserves terminal tab and pane routing for native file drops', () => {
    expect(
      resolveNativeFileDropPath([
        {
          terminalPaneLeafId: 'leaf-1'
        },
        {
          nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.terminal,
          terminalTabId: 'tab-1'
        }
      ])
    ).toEqual({
      target: NATIVE_FILE_DROP_TARGET.terminal,
      tabId: 'tab-1',
      paneLeafId: 'leaf-1'
    })
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

describe('validateNativeFileDropPaths', () => {
  it('rejects native drops by file count before path byte accounting is needed', () => {
    const paths = Array.from({ length: NATIVE_FILE_DROP_MAX_PATHS + 1 }, (_value, index) =>
      ['/tmp/file-', String(index)].join('')
    )

    expect(validateNativeFileDropPaths(paths)).toEqual({
      byteLength: 0,
      pathCount: NATIVE_FILE_DROP_MAX_PATHS + 1,
      reason: 'too-many-paths',
      status: 'rejected'
    })
  })

  it('rejects native drops whose path list is too large without exposing paths', () => {
    const validation = validateNativeFileDropPaths(['C:\\Users\\alice\\secret-token.txt'], {
      maxPathBytes: 4
    })

    expect(validation).toEqual({
      byteLength: 5,
      pathCount: 1,
      reason: 'paths-too-large',
      status: 'rejected'
    })
    if (validation.status === 'rejected') {
      const payload = createRejectedNativeFileDropPayload(validation)
      expect(JSON.stringify(payload)).not.toContain('secret')
      expect(JSON.stringify(payload)).not.toContain('alice')
    }
  })

  it('accepts path payloads within the configured limits', () => {
    expect(validateNativeFileDropPaths(['/tmp/a', '/tmp/b'])).toEqual({
      byteLength: 12,
      pathCount: 2,
      status: 'accepted'
    })
  })

  it('rejects multibyte native path lists with bounded byte accounting', () => {
    expect(validateNativeFileDropPaths(['😀'.repeat(3)], { maxPathBytes: 5 })).toEqual({
      byteLength: 8,
      pathCount: 1,
      reason: 'paths-too-large',
      status: 'rejected'
    })
  })
})

describe('createNativeFileDropPayload', () => {
  it('preserves terminal tab and pane routing in accepted payloads', () => {
    expect(
      createNativeFileDropPayload(
        { target: NATIVE_FILE_DROP_TARGET.terminal, tabId: 'tab-1', paneLeafId: 'leaf-1' },
        ['/tmp/a']
      )
    ).toEqual({
      paneLeafId: 'leaf-1',
      paths: ['/tmp/a'],
      tabId: 'tab-1',
      target: NATIVE_FILE_DROP_TARGET.terminal
    })
  })

  it('preserves file explorer destination routing in accepted payloads', () => {
    expect(
      createNativeFileDropPayload(
        { target: NATIVE_FILE_DROP_TARGET.fileExplorer, destinationDir: '/repo/src' },
        ['/tmp/a']
      )
    ).toEqual({
      destinationDir: '/repo/src',
      paths: ['/tmp/a'],
      target: NATIVE_FILE_DROP_TARGET.fileExplorer
    })
  })

  it('falls back to editor for unmarked drops and fails closed for rejected targets', () => {
    expect(createNativeFileDropPayload(null, ['/tmp/a'])).toEqual({
      paths: ['/tmp/a'],
      target: NATIVE_FILE_DROP_TARGET.editor
    })
    expect(createNativeFileDropPayload({ target: 'rejected' }, ['/tmp/a'])).toBeNull()
  })

  it('returns metadata-only rejected payloads for oversized path lists', () => {
    const payload = createNativeFileDropPayload(null, [
      'C:\\Users\\alice\\',
      'a'.repeat(NATIVE_FILE_DROP_MAX_PATH_BYTES)
    ])

    expect(payload).toEqual({
      byteLength: NATIVE_FILE_DROP_MAX_PATH_BYTES + 1,
      pathCount: 2,
      reason: 'paths-too-large',
      target: 'rejected'
    })
    expect(JSON.stringify(payload)).not.toContain('alice')
  })
})

describe('isNativeFileDropPayload', () => {
  it('accepts bounded native file-drop payload shapes', () => {
    expect(
      isNativeFileDropPayload({
        paths: ['/tmp/a'],
        target: NATIVE_FILE_DROP_TARGET.editor
      })
    ).toBe(true)
    expect(
      isNativeFileDropPayload({
        destinationDir: '/repo/src',
        paths: ['/tmp/a'],
        target: NATIVE_FILE_DROP_TARGET.fileExplorer
      })
    ).toBe(true)
    expect(
      isNativeFileDropPayload({
        paneLeafId: 'leaf-1',
        paths: ['/tmp/a'],
        tabId: 'tab-1',
        target: NATIVE_FILE_DROP_TARGET.terminal
      })
    ).toBe(true)
    expect(
      isNativeFileDropPayload({
        byteLength: 0,
        pathCount: NATIVE_FILE_DROP_MAX_PATHS + 1,
        reason: 'too-many-paths',
        target: 'rejected'
      })
    ).toBe(true)
  })

  it('rejects malformed or unbounded native file-drop payloads', () => {
    expect(isNativeFileDropPayload(null)).toBe(false)
    expect(isNativeFileDropPayload({ paths: ['/tmp/a'], target: 'browser' })).toBe(false)
    expect(
      isNativeFileDropPayload({
        paths: ['/tmp/a'],
        target: NATIVE_FILE_DROP_TARGET.fileExplorer
      })
    ).toBe(false)
    expect(
      isNativeFileDropPayload({
        paths: ['/tmp/a'],
        tabId: 42,
        target: NATIVE_FILE_DROP_TARGET.terminal
      })
    ).toBe(false)
    expect(
      isNativeFileDropPayload({
        paths: Array.from({ length: NATIVE_FILE_DROP_MAX_PATHS + 1 }, () => '/tmp/a'),
        target: NATIVE_FILE_DROP_TARGET.editor
      })
    ).toBe(false)
    expect(
      isNativeFileDropPayload({
        paths: ['a'.repeat(NATIVE_FILE_DROP_MAX_PATH_BYTES + 1)],
        target: NATIVE_FILE_DROP_TARGET.editor
      })
    ).toBe(false)
    expect(
      isNativeFileDropPayload({
        byteLength: 0,
        pathCount: 1,
        reason: 'contains-secret-path',
        target: 'rejected'
      })
    ).toBe(false)
  })

  it('enforces native file-drop count and byte limits at their boundaries', () => {
    expect(
      isNativeFileDropPayload({
        paths: Array.from(
          { length: NATIVE_FILE_DROP_MAX_PATHS },
          (_value, index) => `/tmp/${index}`
        ),
        target: NATIVE_FILE_DROP_TARGET.editor
      })
    ).toBe(true)
    expect(
      isNativeFileDropPayload({
        paths: Array.from(
          { length: NATIVE_FILE_DROP_MAX_PATHS + 1 },
          (_value, index) => `/tmp/${index}`
        ),
        target: NATIVE_FILE_DROP_TARGET.editor
      })
    ).toBe(false)
    expect(
      isNativeFileDropPayload({
        paths: ['a'.repeat(NATIVE_FILE_DROP_MAX_PATH_BYTES)],
        target: NATIVE_FILE_DROP_TARGET.editor
      })
    ).toBe(true)
    expect(
      isNativeFileDropPayload({
        paths: ['a'.repeat(NATIVE_FILE_DROP_MAX_PATH_BYTES + 1)],
        target: NATIVE_FILE_DROP_TARGET.editor
      })
    ).toBe(false)
  })
})
