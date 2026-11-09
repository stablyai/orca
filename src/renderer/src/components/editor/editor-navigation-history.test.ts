import { describe, expect, it } from 'vitest'
import { createEditorNavigationHistory } from './editor-navigation-history'
import { DIRECTION } from './editor-navigation.consts'
import type { Location } from './editor-navigation.types'

function location(filePath: string, lineNumber: number, options: Partial<Location> = {}): Location {
  return {
    file: {
      id: filePath,
      filePath,
      relativePath: filePath,
      worktreeId: 'workspace',
      language: 'typescript',
      isDirty: false,
      mode: 'edit'
    },
    ownerKey: '',
    position: { lineNumber, column: 1 },
    scrollTop: 0,
    scrollLeft: 0,
    ...options
  }
}

describe('createEditorNavigationHistory', () => {
  it('returns across files with the last cursor and viewport, then walks forward', () => {
    const history = createEditorNavigationHistory()
    history.record(location('app.ts', 40))
    history.update(location('app.ts', 42, { scrollTop: 700, scrollLeft: 35 }))
    history.record(location('utils.ts', 120))

    expect(history.step(DIRECTION.BACK)).toMatchObject({
      file: { filePath: 'app.ts' },
      position: { lineNumber: 42, column: 1 },
      scrollTop: 700,
      scrollLeft: 35
    })
    expect(history.step(DIRECTION.BACK)).toBeNull()
    expect(history.step(DIRECTION.FORWARD)).toMatchObject({
      file: { filePath: 'utils.ts' },
      position: { lineNumber: 120 }
    })
    expect(history.step(DIRECTION.FORWARD)).toBeNull()
  })

  it('coalesces nearby cursor moves and preserves significant jumps in one file', () => {
    const history = createEditorNavigationHistory()
    history.record(location('app.ts', 1))
    history.record(location('app.ts', 2))
    history.record(location('app.ts', 3))
    history.record(location('app.ts', 60))
    history.record(location('app.ts', 61))

    expect(history.step(DIRECTION.BACK)?.position).toEqual({
      lineNumber: 3,
      column: 1
    })
    expect(history.step(DIRECTION.BACK)).toBeNull()
    expect(history.step(DIRECTION.FORWARD)?.position).toEqual({
      lineNumber: 61,
      column: 1
    })
  })

  it('records explicit jumps to nearby definitions and drops forward history on a new jump', () => {
    const history = createEditorNavigationHistory()
    history.record(location('app.ts', 5))
    history.record(location('app.ts', 7), true)
    history.record(location('old.ts', 80))

    expect(history.step(DIRECTION.BACK)?.position.lineNumber).toBe(7)
    history.record(location('new.ts', 12))
    expect(history.step(DIRECTION.FORWARD)).toBeNull()
    expect(history.step(DIRECTION.BACK)).toMatchObject({
      file: { filePath: 'app.ts' },
      position: { lineNumber: 7 }
    })
    expect(history.step(DIRECTION.BACK)?.position.lineNumber).toBe(5)
  })

  it('keeps split copies and different owners of the same path distinct', () => {
    const history = createEditorNavigationHistory()
    history.record(location('app.ts', 10, { tabId: 'left', ownerKey: 'local' }))
    history.record(location('app.ts', 12, { tabId: 'right', ownerKey: 'local' }))
    history.record(location('app.ts', 14, { tabId: 'right', ownerKey: 'remote' }))

    expect(history.step(DIRECTION.BACK)).toMatchObject({
      tabId: 'right',
      ownerKey: 'local',
      position: { lineNumber: 12 }
    })
    expect(history.step(DIRECTION.BACK)).toMatchObject({
      tabId: 'left',
      ownerKey: 'local',
      position: { lineNumber: 10 }
    })
  })

  it('skips unavailable targets without losing the current location at a dead end', () => {
    const history = createEditorNavigationHistory()
    history.record(location('retired.ts', 10))
    history.record(location('available.ts', 30))
    history.record(location('current.ts', 50))

    expect(
      history.step(DIRECTION.BACK, (entry) => entry.file.filePath !== 'retired.ts')
    ).toMatchObject({
      file: { filePath: 'available.ts' }
    })
    expect(history.step(DIRECTION.BACK, () => false)).toBeNull()
    expect(history.step(DIRECTION.FORWARD)).toMatchObject({
      file: { filePath: 'current.ts' }
    })
  })
})
