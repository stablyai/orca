import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugSnapshot, DebugStackFrameWire } from '../../../../preload/api/debug-api'
import type { DebugClient } from './debug-client'
import type { DebugEditorBinding } from './connect-debug-editor'
import { createDebugSessionStore } from './use-debug-session'
import {
  FRAME_ARROW_CLASS,
  FRAME_LINE_CLASS,
  installStoppedLocation,
  STOPPED_ARROW_CLASS,
  STOPPED_LINE_CLASS
} from './stopped-location-decorations'

const FILE = '/repo/src/app.py'
const OTHER = '/repo/src/other.py'

function snapshot(seq: number, stopped: boolean): DebugSnapshot {
  return {
    seq,
    worktreePath: '/repo',
    status: stopped ? 'stopped' : 'running',
    configName: 'Run',
    adapterId: 'debugpy',
    capabilities: {},
    stopped: stopped ? { reason: 'breakpoint', threadId: 1, allThreadsStopped: true } : null,
    threads: [{ id: 1, name: 'main' }],
    breakpoints: [],
    exceptionFilters: { available: [], enabled: [] },
    lastError: null
  }
}

const frame = (id: number, path: string, line: number): DebugStackFrameWire => ({
  id,
  name: `f${id}`,
  source: { path },
  line,
  column: 3
})

function setup(frames: DebugStackFrameWire[], open: string[] = [FILE]) {
  const decorations: editor.IModelDeltaDecoration[][] = []
  const collection = {
    set: vi.fn((next: editor.IModelDeltaDecoration[]) => decorations.push(next)),
    clear: vi.fn(() => decorations.push([]))
  }
  const instance = {
    createDecorationsCollection: () => collection,
    revealLineInCenterIfOutsideViewport: vi.fn()
  }
  const stackTrace = vi.fn(async () => ({ ok: true as const, value: { stackFrames: frames } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store calls only stackTrace, onState and onOutput.
  const client = {
    stackTrace,
    onState: () => () => {},
    onOutput: () => () => {}
  } as unknown as DebugClient
  const sessionStore = createDebugSessionStore(client)
  const binding: DebugEditorBinding = {
    target: { repoId: 'r1', worktreePath: '/repo-link' },
    filePath: FILE,
    getCoreRoot: () => '/repo',
    isThisFile: (path) => path === FILE,
    toEditorPath: (path) => path
  }
  const reveal = { isOpen: vi.fn((path: string) => open.includes(path)), open: vi.fn() }
  const installed = installStoppedLocation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every editor member the stopped line reads.
    instance as unknown as editor.IStandaloneCodeEditor,
    binding,
    { sessionStore, reveal }
  )
  const last = () => decorations.at(-1) ?? []
  return { sessionStore, reveal, installed, last, stackTrace, instance, collection }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('stopped location', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('highlights the stopped line and clears it on continue', async () => {
    const { sessionStore, last, stackTrace, instance } = setup([frame(0, FILE, 12)])
    sessionStore.ingestSnapshot(snapshot(1, true))
    await settle()
    expect(stackTrace).toHaveBeenCalledWith({ repoId: 'r1', worktreePath: '/repo', threadId: 1 })
    expect(last()).toHaveLength(1)
    expect(last()[0].range.startLineNumber).toBe(12)
    expect(last()[0].options).toMatchObject({
      isWholeLine: true,
      className: STOPPED_LINE_CLASS,
      glyphMarginClassName: STOPPED_ARROW_CLASS
    })
    expect(instance.revealLineInCenterIfOutsideViewport).toHaveBeenCalledWith(12)

    sessionStore.ingestSnapshot(snapshot(2, false))
    expect(last()).toEqual([])
  })

  it('marks a selected non-top frame with its own class', async () => {
    const { sessionStore, last } = setup([frame(0, OTHER, 4), frame(7, FILE, 30)], [FILE, OTHER])
    sessionStore.ingestSnapshot(snapshot(1, true))
    await settle()
    expect(last()).toEqual([])
    sessionStore.selectFrame('/repo', 7)
    expect(last()[0].range.startLineNumber).toBe(30)
    expect(last()[0].options).toMatchObject({
      className: FRAME_LINE_CLASS,
      glyphMarginClassName: FRAME_ARROW_CLASS
    })
  })

  it('opens the top frame’s file once per stop when it is not open', async () => {
    const { sessionStore, reveal } = setup([frame(0, OTHER, 4), frame(1, FILE, 9)])
    sessionStore.ingestSnapshot(snapshot(1, true))
    await settle()
    expect(reveal.open).toHaveBeenCalledTimes(1)
    expect(reveal.open).toHaveBeenCalledWith(OTHER, '/repo-link', 4, 3)

    // Re-stamps and frame picks within the same stop do not reopen it.
    sessionStore.ingestSnapshot({ ...snapshot(2, true) })
    sessionStore.selectFrame('/repo', 1)
    await settle()
    expect(reveal.open).toHaveBeenCalledTimes(1)

    sessionStore.ingestSnapshot(snapshot(3, false))
    sessionStore.ingestSnapshot(snapshot(4, true))
    await settle()
    expect(reveal.open).toHaveBeenCalledTimes(2)
  })

  it('does not open a file that is already open', async () => {
    const { sessionStore, reveal } = setup([frame(0, OTHER, 4)], [FILE, OTHER])
    sessionStore.ingestSnapshot(snapshot(1, true))
    await settle()
    expect(reveal.open).not.toHaveBeenCalled()
  })

  it('dispose stops listening and clears the line', async () => {
    const { sessionStore, installed, collection, last } = setup([frame(0, FILE, 12)])
    installed.dispose()
    expect(collection.clear).toHaveBeenCalled()
    sessionStore.ingestSnapshot(snapshot(1, true))
    await settle()
    expect(last()).toEqual([])
  })
})
