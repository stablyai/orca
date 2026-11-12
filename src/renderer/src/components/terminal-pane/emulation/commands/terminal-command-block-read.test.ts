import { describe, expect, it } from 'vitest'
import type { IMarker } from '@xterm/xterm'
import {
  isTerminalCommandBlockAlive,
  selectMenuCommandBlockForCopy
} from './terminal-command-block-read'
import type { TrackedCommandBlock } from './terminal-command-block-tracker'

function stubMarker(disposed: boolean): IMarker {
  return { isDisposed: disposed } as IMarker
}

function stubBlock(options?: {
  promptDisposed?: boolean
  outputStartDisposed?: boolean
  outputEndDisposed?: boolean
  repainted?: boolean
}): TrackedCommandBlock {
  return {
    promptMarker: stubMarker(options?.promptDisposed ?? false),
    outputStartMarker: stubMarker(options?.outputStartDisposed ?? false),
    outputEndMarker: stubMarker(options?.outputEndDisposed ?? false),
    inputStartMarker: null,
    inputStartCol: 0,
    outputEndExtraRow: false,
    outputEndRowSnapshot: null,
    outputEndRowRepainted: options?.repainted ?? false,
    commandSnapshot: null,
    exitCode: 0
  }
}

describe('terminal-command-block-read', () => {
  it('reports a block alive only while all its markers are', () => {
    expect(isTerminalCommandBlockAlive(stubBlock())).toBe(true)
    expect(isTerminalCommandBlockAlive(stubBlock({ promptDisposed: true }))).toBe(false)
    expect(isTerminalCommandBlockAlive(stubBlock({ outputStartDisposed: true }))).toBe(false)
    expect(isTerminalCommandBlockAlive(stubBlock({ outputEndDisposed: true }))).toBe(false)
  })

  it('rejects the copy when nothing was captured or the block died', () => {
    const live = stubBlock()
    expect(selectMenuCommandBlockForCopy(null, live)).toBeNull()
    expect(selectMenuCommandBlockForCopy(stubBlock({ promptDisposed: true }), live)).toBeNull()
    expect(selectMenuCommandBlockForCopy(stubBlock({ outputEndDisposed: true }), null)).toBeNull()
  })

  it('uses the captured block when resolution still agrees', () => {
    const captured = stubBlock()
    expect(selectMenuCommandBlockForCopy(captured, captured)).toBe(captured)
  })

  it('trusts the captured block when a trim moved resolution elsewhere', () => {
    const captured = stubBlock()
    // Markers follow the scroll; the stale row now resolves a neighbor.
    expect(selectMenuCommandBlockForCopy(captured, stubBlock())).toBe(captured)
    expect(selectMenuCommandBlockForCopy(captured, null)).toBe(captured)
  })

  it('rejects a repainted block once resolution moved on', () => {
    const captured = stubBlock({ repainted: true })
    expect(selectMenuCommandBlockForCopy(captured, stubBlock())).toBeNull()
    expect(selectMenuCommandBlockForCopy(captured, null)).toBeNull()
  })

  it('keeps a repainted block while it still owns the clicked row', () => {
    const captured = stubBlock({ repainted: true })
    expect(selectMenuCommandBlockForCopy(captured, captured)).toBe(captured)
  })
})
