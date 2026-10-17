// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DebugOutputEvent,
  DebugSnapshot,
  DebugStackFrameWire
} from '../../../../preload/api/debug-api'
import { createDebugClient, type DebugClient } from './debug-client'
import {
  createDebugSessionStore,
  DEBUG_CONSOLE_LINE_CAP,
  useDebugSession,
  type DebugSessionState
} from './use-debug-session'

function snapshot(
  seq: number,
  stopped: DebugSnapshot['stopped'] = null,
  worktreePath = '/real/a'
): DebugSnapshot {
  return {
    seq,
    worktreePath,
    status: stopped ? 'stopped' : 'running',
    configName: 'Run',
    adapterId: 'debugpy',
    capabilities: {},
    stopped,
    threads: [
      { id: 1, name: 'main' },
      { id: 2, name: 'worker' }
    ],
    breakpoints: [],
    exceptionFilters: { available: [], enabled: [] },
    lastError: null
  }
}

const stop = (threadId: number): DebugSnapshot['stopped'] => ({
  reason: 'breakpoint',
  threadId,
  allThreadsStopped: true
})
const frame = (id: number): DebugStackFrameWire => ({
  id,
  name: `f${id}`,
  line: id,
  column: 1
})
const output = (seq: number, text: string, worktreePath = '/real/a'): DebugOutputEvent => ({
  worktreePath,
  seq,
  ts: seq,
  category: 'stdout',
  text
})

function fakeClient(frames: DebugStackFrameWire[] = [frame(10), frame(11)]) {
  const state = new Set<(snapshot: DebugSnapshot) => void>()
  const out = new Set<(event: DebugOutputEvent) => void>()
  const client: Pick<DebugClient, 'onState' | 'onOutput' | 'stackTrace'> = {
    onState: (listener) => {
      state.add(listener)
      return () => state.delete(listener)
    },
    onOutput: (listener) => {
      out.add(listener)
      return () => out.delete(listener)
    },
    stackTrace: vi.fn(async () => ({
      ok: true as const,
      value: { stackFrames: frames }
    }))
  }
  return {
    client,
    emitState: (value: DebugSnapshot) => state.forEach((listener) => listener(value)),
    emitOutput: (value: DebugOutputEvent) => out.forEach((listener) => listener(value))
  }
}

describe('debug session store', () => {
  it('ignores a snapshot whose seq is not newer', () => {
    const store = createDebugSessionStore(fakeClient().client)
    store.ingestSnapshot(snapshot(5))
    store.ingestSnapshot(snapshot(3, stop(1)))
    store.ingestSnapshot(snapshot(5, stop(1)))
    expect(store.getState('/real/a').snapshot?.seq).toBe(5)
    expect(store.getState('/real/a').selectedThreadId).toBeNull()
  })

  it('defaults to the stopped thread’s top frame and resets on continue', async () => {
    const { client } = fakeClient()
    const store = createDebugSessionStore(client)
    const target = { repoId: 'r', worktreePath: '/real/a' }
    store.ingestSnapshot(snapshot(1, stop(2)))
    expect(store.getState('/real/a').selectedThreadId).toBe(2)
    await store.loadFrames(target)
    expect(client.stackTrace).toHaveBeenCalledWith({ ...target, threadId: 2 })
    expect(store.getState('/real/a').selectedFrameId).toBe(10)

    store.selectFrame('/real/a', 11)
    store.ingestSnapshot(snapshot(2, stop(2)))
    expect(store.getState('/real/a').selectedFrameId).toBe(11)

    store.ingestSnapshot(snapshot(3))
    const continued = store.getState('/real/a')
    expect(continued.selectedThreadId).toBeNull()
    expect(continued.selectedFrameId).toBeNull()
    expect(continued.frames).toEqual([])
  })

  it('drops frames answered for an earlier stop', async () => {
    const { client } = fakeClient()
    const store = createDebugSessionStore(client)
    store.ingestSnapshot(snapshot(1, stop(1)))
    const pending = store.loadFrames({ repoId: 'r', worktreePath: '/real/a' })
    store.ingestSnapshot(snapshot(2))
    store.ingestSnapshot(snapshot(3, stop(1)))
    await pending
    expect(store.getState('/real/a').frames).toEqual([])
    expect(store.getState('/real/a').selectedFrameId).toBeNull()
  })

  it('caps the console at the newest lines and skips replayed output', () => {
    const store = createDebugSessionStore(fakeClient().client)
    for (let seq = 1; seq <= DEBUG_CONSOLE_LINE_CAP + 5; seq++) {
      store.ingestOutput(output(seq, `line ${seq}`))
    }
    store.ingestOutput(output(3, 'replayed'))
    const lines = store.getState('/real/a').console
    expect(lines).toHaveLength(DEBUG_CONSOLE_LINE_CAP)
    expect(lines[0].text).toBe('line 6')
    expect(lines.at(-1)?.text).toBe(`line ${DEBUG_CONSOLE_LINE_CAP + 5}`)
  })

  it('loads the top frame itself on a stop once the repo is bound, and again on a same-thread re-stop', async () => {
    const { client } = fakeClient()
    const store = createDebugSessionStore(client)
    store.bindRepo('/real/a', 'r')
    store.ingestSnapshot(snapshot(1, stop(2)))
    await vi.waitFor(() => expect(store.getState('/real/a').selectedFrameId).toBe(10))
    expect(client.stackTrace).toHaveBeenCalledWith({
      repoId: 'r',
      worktreePath: '/real/a',
      threadId: 2
    })
    store.ingestSnapshot(snapshot(2, stop(2)))
    expect(store.getState('/real/a').stopSeq).toBe(2)
    await vi.waitFor(() => expect(client.stackTrace).toHaveBeenCalledTimes(2))
  })

  it('loads frames on bind when already stopped, and on a thread switch', async () => {
    const { client } = fakeClient()
    const store = createDebugSessionStore(client)
    store.ingestSnapshot(snapshot(1, stop(1)))
    expect(client.stackTrace).not.toHaveBeenCalled()
    store.bindRepo('/real/a', 'r')
    await vi.waitFor(() => expect(store.getState('/real/a').selectedFrameId).toBe(10))
    store.selectThread('/real/a', 2)
    await vi.waitFor(() =>
      expect(client.stackTrace).toHaveBeenLastCalledWith({
        repoId: 'r',
        worktreePath: '/real/a',
        threadId: 2
      })
    )
  })

  it('rejects replayed output after a console clear', () => {
    const store = createDebugSessionStore(fakeClient().client)
    store.ingestOutput(output(5, 'five'))
    store.clearConsole('/real/a')
    store.ingestOutput(output(4, 'replayed'))
    store.ingestOutput(output(5, 'replayed'))
    expect(store.getState('/real/a').console).toEqual([])
    store.ingestOutput(output(6, 'six'))
    expect(store.getState('/real/a').console.map((line) => line.text)).toEqual(['six'])
  })

  it('keeps two worktrees apart', () => {
    const { client, emitState, emitOutput } = fakeClient()
    const store = createDebugSessionStore(client)
    store.connect()
    emitState(snapshot(4, stop(1), '/real/a'))
    emitState(snapshot(2, null, '/real/b'))
    emitOutput(output(5, 'from a', '/real/a'))
    emitOutput(output(6, 'from b', '/real/b'))
    store.selectConfiguration('/real/b', 'Attach')
    const a = store.getState('/real/a')
    const b = store.getState('/real/b')
    expect([a.snapshot?.seq, b.snapshot?.seq]).toEqual([4, 2])
    expect([a.selectedThreadId, b.selectedThreadId]).toEqual([1, null])
    expect(a.console.map((line) => line.text)).toEqual(['from a'])
    expect(b.console.map((line) => line.text)).toEqual(['from b'])
    expect([a.configName, b.configName]).toEqual([null, 'Attach'])
  })
})

describe('useDebugSession', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  it('renders the worktree’s state and follows pushes from the client', () => {
    const { client, emitState } = fakeClient()
    const store = createDebugSessionStore(client)
    const seen: DebugSessionState[] = []
    function Probe({ path }: { path: string }) {
      seen.push(useDebugSession(path, store))
      return null
    }
    const container = document.createElement('div')
    root = createRoot(container)
    act(() => root?.render(<Probe path="/real/a" />))
    expect(seen.at(-1)?.snapshot).toBeNull()
    act(() => emitState(snapshot(1, stop(1), '/real/b')))
    expect(seen.at(-1)?.snapshot).toBeNull()
    act(() => emitState(snapshot(2, stop(1), '/real/a')))
    expect(seen.at(-1)?.snapshot?.seq).toBe(2)
    expect(seen.at(-1)?.selectedThreadId).toBe(1)
  })

  it('reads an empty session through a client with no bridge', () => {
    const store = createDebugSessionStore(createDebugClient(() => undefined))
    expect(() => store.connect()).not.toThrow()
    expect(store.getState('/real/a').snapshot).toBeNull()
  })
})
