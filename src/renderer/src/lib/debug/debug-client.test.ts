import { describe, expect, it, vi } from 'vitest'
import type {
  DebugApi,
  DebugOutputEvent,
  DebugResult,
  DebugSnapshot
} from '../../../../preload/api/debug-api'
import { createDebugClient } from './debug-client'
import { resolveDebugEditorContext } from './debug-editor-context'

function fakeBridge() {
  const state = new Set<(snapshot: DebugSnapshot) => void>()
  const output = new Set<(event: DebugOutputEvent) => void>()
  const bridge = {
    subscribe: vi.fn(async (): Promise<DebugResult<null>> => ({
      ok: true,
      value: null
    })),
    onState: vi.fn((listener: (snapshot: DebugSnapshot) => void) => {
      state.add(listener)
      return () => state.delete(listener)
    }),
    onOutput: vi.fn((listener: (event: DebugOutputEvent) => void) => {
      output.add(listener)
      return () => output.delete(listener)
    }),
    stop: vi.fn(async () => ({ ok: true as const, value: snapshot(1) })),
    pause: vi.fn(async () => {
      throw new Error('No handler registered for debug:pause')
    })
  }
  const emitState = (value: DebugSnapshot): void => state.forEach((listener) => listener(value))
  const emitOutput = (value: DebugOutputEvent): void =>
    output.forEach((listener) => listener(value))
  return { bridge, emitState, emitOutput }
}

function snapshot(seq: number, worktreePath = '/repo'): DebugSnapshot {
  return {
    seq,
    worktreePath,
    status: 'running',
    configName: null,
    adapterId: null,
    capabilities: {},
    stopped: null,
    threads: [],
    breakpoints: [],
    exceptionFilters: { available: [], enabled: [] },
    lastError: null
  }
}

// Only the members a test touches; the client never reaches past them.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial fake of the preload bridge.
const asBridge = (fake: Partial<DebugApi>): DebugApi => fake as DebugApi

describe('debug client', () => {
  it('answers unavailable for every call when the bridge is absent', async () => {
    const client = createDebugClient(() => undefined)
    const target = { repoId: 'r', worktreePath: '/repo' }
    expect(client.available).toBe(false)
    await expect(client.stop(target)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable'
    })
    await expect(client.previewLaunch(target)).resolves.toMatchObject({
      reason: 'unavailable'
    })
    await expect(client.subscribe()).resolves.toMatchObject({
      reason: 'unavailable'
    })
    expect(() => client.onState(() => {})()).not.toThrow()
  })

  it('reads a missing window bridge as unavailable', async () => {
    const client = createDebugClient()
    await expect(client.listBreakpoints({ repoId: 'r', worktreePath: '/repo' })).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: 'unavailable' })
    )
  })

  it('passes calls through and turns a rejected invoke into a refusal', async () => {
    const { bridge } = fakeBridge()
    const client = createDebugClient(() => asBridge(bridge))
    const target = { repoId: 'r', worktreePath: '/repo' }
    await expect(client.stop(target)).resolves.toMatchObject({
      ok: true,
      value: { seq: 1 }
    })
    expect(bridge.stop).toHaveBeenCalledWith(target)
    await expect(client.pause({ ...target, threadId: 1 })).resolves.toMatchObject({
      ok: false,
      reason: 'request-failed'
    })
  })

  it('routes every call to its own bridge member with the argument object unchanged', async () => {
    const methods = [
      'describeAdapters',
      'listConfigs',
      'previewLaunch',
      'approveLaunch',
      'start',
      'stop',
      'restart',
      'continue',
      'next',
      'stepIn',
      'stepOut',
      'pause',
      'threads',
      'stackTrace',
      'scopes',
      'variables',
      'evaluate',
      'setVariable',
      'setExceptionFilters',
      'addBreakpoint',
      'updateBreakpoint',
      'removeBreakpoint',
      'setFileLines',
      'listBreakpoints',
      'snapshot',
      'eventsSince'
    ] as const
    const bridge = Object.fromEntries(
      methods.map((name) => [
        name,
        vi.fn(async (_params: unknown) => ({ ok: true as const, value: name }))
      ])
    )
    const client = createDebugClient(() => asBridge(bridge))
    const own = Object.keys(client).filter(
      (key) => !['available', 'subscribe', 'onState', 'onOutput'].includes(key)
    )
    expect(own.sort()).toEqual([...methods].sort())
    const absent = createDebugClient(() => undefined)
    for (const name of methods) {
      const params = {
        repoId: 'r',
        worktreePath: '/repo',
        expectedHash: `hash-${name}`,
        path: '/repo/a.py',
        lines: [{ id: 'bp-1', line: 3 }]
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each member takes one params object.
      const call = client[name] as (p: unknown) => Promise<unknown>
      await expect(call(params), name).resolves.toEqual({ ok: true, value: name })
      expect(bridge[name], name).toHaveBeenCalledTimes(1)
      expect(bridge[name].mock.calls[0]).toEqual([params])
      expect(bridge[name].mock.calls[0][0], name).toBe(params)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      const missing = absent[name] as (p: unknown) => Promise<unknown>
      await expect(missing(params), name).resolves.toMatchObject({
        ok: false,
        reason: 'unavailable'
      })
    }
  })

  it('subscribes once and fans state and output out to every listener', async () => {
    const { bridge, emitState, emitOutput } = fakeBridge()
    const client = createDebugClient(() => asBridge(bridge))
    const a = vi.fn()
    const b = vi.fn()
    const out = vi.fn()
    const offA = client.onState(a)
    client.onState(b)
    client.onOutput(out)
    await client.subscribe()
    expect(bridge.subscribe).toHaveBeenCalledTimes(1)
    expect(bridge.onState).toHaveBeenCalledTimes(1)
    expect(bridge.onOutput).toHaveBeenCalledTimes(1)

    emitState(snapshot(3))
    offA()
    emitState(snapshot(4))
    emitOutput({
      worktreePath: '/repo',
      seq: 5,
      ts: 0,
      category: 'stdout',
      text: 'hi'
    })
    expect(a.mock.calls.map(([s]) => s.seq)).toEqual([3])
    expect(b.mock.calls.map(([s]) => s.seq)).toEqual([3, 4])
    expect(out).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }))
  })

  it('retries the subscribe after a refusal', async () => {
    const { bridge } = fakeBridge()
    bridge.subscribe.mockResolvedValueOnce({
      ok: false,
      reason: 'untrusted-renderer',
      message: 'no'
    })
    const client = createDebugClient(() => asBridge(bridge))
    await expect(client.subscribe()).resolves.toMatchObject({ ok: false })
    await expect(client.subscribe()).resolves.toMatchObject({ ok: true })
    expect(bridge.subscribe).toHaveBeenCalledTimes(2)
    expect(bridge.onState).toHaveBeenCalledTimes(1)
  })
})

describe('resolveDebugEditorContext', () => {
  it('prefers the known worktree path and falls back to the id', () => {
    const worktreeId = 'repo-1::/work/tree::workspace:12345678-1234-1234-1234-123456789abc'
    const known = {
      worktreesByRepo: { 'repo-1': [{ id: worktreeId, path: '/real/tree' }] }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution reads only id and path.
    expect(resolveDebugEditorContext(known as never, worktreeId, '/real/tree/a.py')).toEqual({
      repoId: 'repo-1',
      rootPath: '/real/tree',
      filePath: '/real/tree/a.py'
    })
    expect(resolveDebugEditorContext({}, worktreeId, '/work/tree/a.py')).toEqual({
      repoId: 'repo-1',
      rootPath: '/work/tree',
      filePath: '/work/tree/a.py'
    })
    expect(resolveDebugEditorContext({}, undefined, '/a.py')).toBeNull()
  })
})
