// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, Profiler, StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonSession } from './resource-usage-merge-types'
import { notifyDaemonSessionInventoryInvalidated } from './daemon-session-inventory-invalidation'
import { useResourceSessionInventory } from './use-resource-session-inventory'

type Inventory = ReturnType<typeof useResourceSessionInventory>
const rows: DaemonSession[] = Array.from({ length: 12 }, (_, index) => ({
  id: index % 2 ? `ssh-${index}` : `native-${index}`,
  title: `Terminal ${index}`,
  cwd: index % 2 ? 'C:\\folder' : '/folder',
  agentOwnership: 'absent'
}))
let spawned: (data: { id: string }) => void
let exited: (data: { id: string; code: number }) => void
const list = vi.fn<() => Promise<DaemonSession[]>>()
let stopped: string[]
function setup(hook: typeof useResourceSessionInventory, ready = true, strict = false) {
  let renders = 0
  let commits = 0
  const view = renderHook(
    (props: { ready: boolean }) => {
      renders += 1
      return hook(props.ready)
    },
    {
      initialProps: { ready },
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(
          Profiler,
          {
            id: 'inventory',
            onRender: () => {
              commits += 1
            }
          },
          strict ? createElement(StrictMode, null, children) : children
        )
    }
  )
  return { ...view, renders: () => renders, commits: () => commits }
}
function output(value: Inventory, expected: readonly DaemonSession[], failed = false): void {
  expect(value.sessionsError).toBe(failed)
  expect(value.sessionInventory.count).toBe(expected.length)
  expect(value.sessionInventory.sessions).toEqual(expected)
  expected.forEach((row, index) => expect(value.sessionInventory.sessions[index]).toBe(row))
}
function deferred() {
  let resolve: (rows: DaemonSession[]) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<DaemonSession[]>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.useFakeTimers()
  stopped = []
  list.mockReset().mockResolvedValue(rows)
  vi.stubGlobal('api', {
    pty: {
      listSessions: list,
      onSpawned: (callback: typeof spawned) => {
        spawned = callback
        return () => stopped.push('spawn')
      },
      onExit: (callback: typeof exited) => {
        exited = callback
        return () => stopped.push('exit')
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([1, 2, 8, 64])(
  'counts %s ordinary closed-inventory exits with complete parity first',
  async (events) => {
    list.mockResolvedValue(rows)
    const view = setup(useResourceSessionInventory)
    await act(async () => {})
    const initial = view.result.current
    const before = view.renders(),
      requests = list.mock.calls.length
    for (let index = 0; index < events; index += 1) {
      act(() => exited({ id: `unlisted-${index}`, code: 0 }))
      output(view.result.current, rows)
      expect(view.result.current.sessionInventory).toBe(initial.sessionInventory)
      expect(view.result.current.refreshSessions).toBe(initial.refreshSessions)
    }
    expect(list.mock.calls.length).toBe(requests)
    expect(vi.getTimerCount()).toBe(0)
    const renders = view.renders() - before
    view.unmount()

    expect(renders).toBe(1)
  }
)

it('preserves complete inventory and request provenance for real short-lived spawn/exit notifications before render counts', async () => {
  const view = setup(useResourceSessionInventory)
  await act(async () => {})
  output(view.result.current, rows)
  const initial = view.result.current
  const before = view.renders(),
    committed = view.commits(),
    calls = list.mock.calls.length
  for (let index = 0; index < 100; index += 1) {
    act(() => {
      spawned({ id: `short-lived-${index}` })
      exited({ id: `short-lived-${index}`, code: 0 })
    })
    output(view.result.current, rows)
    expect(view.result.current.sessionInventory).toBe(initial.sessionInventory)
    expect(view.result.current.refreshSessions).toBe(initial.refreshSessions)
    expect(view.result.current.removeSession).toBe(initial.removeSession)
    expect(view.result.current.removeSessions).toBe(initial.removeSessions)
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  output(view.result.current, rows)
  const counts = {
    renders: view.renders() - before,
    commits: view.commits() - committed,
    reads: list.mock.calls.length - calls,
    callbacks: view.result.current.removeSession === initial.removeSession
  }
  view.unmount()
  expect(stopped.slice(-2)).toEqual(['spawn', 'exit'])

  expect(counts.renders).toBeLessThanOrEqual(1)
  expect(counts.reads).toBe(0)
  expect(counts.commits).toBeLessThanOrEqual(1)
})

it('preserves unknown bulk/empty removal, real removal, errors and readiness epochs before counts', async () => {
  list.mockResolvedValue(rows)
  const view = setup(useResourceSessionInventory)
  await act(async () => {})
  const before = view.renders()
  act(() => view.result.current.removeSessions(new Set()))
  output(view.result.current, rows)
  act(() => view.result.current.removeSessions(new Set(['missing', '__proto__'])))
  output(view.result.current, rows)
  const renders = view.renders() - before
  const beforeRemoval = view.result.current.sessionInventory
  act(() => view.result.current.removeSession(rows[0]!.id))
  output(view.result.current, rows.slice(1))
  expect(view.result.current.sessionInventory).not.toBe(beforeRemoval)
  expect(view.result.current.sessionInventory.sessions).not.toBe(beforeRemoval.sessions)
  act(() => view.result.current.removeSessions(new Set([rows[2]!.id, rows[5]!.id])))
  output(
    view.result.current,
    rows.filter((row) => ![rows[0]!.id, rows[2]!.id, rows[5]!.id].includes(row.id))
  )
  list.mockRejectedValueOnce(new Error('original offline'))
  await act(async () => {
    await view.result.current.refreshSessions()
  })
  expect(view.result.current.sessionsError).toBe(true)
  const beforeError = view.result.current.sessionInventory
  act(() => view.result.current.removeSession('absent'))
  expect(view.result.current.sessionsError).toBe(true)
  expect(view.result.current.sessionInventory).toBe(beforeError)
  view.rerender({ ready: false })
  output(view.result.current, [])
  view.rerender({ ready: true })
  await act(async () => {})
  output(view.result.current, rows)
  view.unmount()

  expect(renders).toBe(1)
})

it.each([false, true])(
  'keeps unknown tombstones and same-ID reuse; StrictMode=%s',
  async (strict) => {
    const seed = deferred()
    list.mockReturnValue(seed.promise)
    const view = setup(useResourceSessionInventory, true, strict)
    act(() => view.result.current.removeSession('missing-in-inventory'))
    output(view.result.current, [])
    const missing = { ...rows[0]!, id: 'missing-in-inventory' }
    await act(async () => {
      seed.resolve([...rows, missing])
      await seed.promise
    })
    output(view.result.current, rows)
    list.mockResolvedValueOnce([...rows, missing])
    await act(async () => {
      await view.result.current.refreshSessions()
    })
    output(view.result.current, [...rows, missing])
    const before = list.mock.calls.length
    act(() => spawned({ id: missing.id }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(list.mock.calls.length).toBe(before)
    view.unmount()
  }
)

it.each([false, true])(
  'keeps newest refresh, invalidation and disposal; StrictMode=%s',
  async (strict) => {
    list.mockResolvedValue(rows)
    const view = setup(useResourceSessionInventory, true, strict)
    await act(async () => {})
    const older = deferred(),
      newer = deferred()
    list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    let oldRead: Promise<void> = Promise.resolve(),
      newRead: Promise<void> = Promise.resolve()
    act(() => {
      oldRead = view.result.current.refreshSessions()
      newRead = view.result.current.refreshSessions()
    })
    act(() => exited({ id: rows[0]!.id, code: 0 }))
    await act(async () => {
      newer.resolve(rows)
      await newRead
    })
    output(view.result.current, rows.slice(1))
    await act(async () => {
      older.resolve([])
      await oldRead
    })
    output(view.result.current, rows.slice(1))
    list.mockResolvedValueOnce(rows)
    await act(async () => notifyDaemonSessionInventoryInvalidated())
    output(view.result.current, rows)
    const late = deferred()
    list.mockReturnValueOnce(late.promise)
    act(() => spawned({ id: 'later' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    view.unmount()
    const before = list.mock.calls.length
    await act(async () => {
      late.resolve(rows)
      await late.promise
      await vi.advanceTimersByTimeAsync(1)
      notifyDaemonSessionInventoryInvalidated()
    })
    expect(list.mock.calls.length).toBe(before)
  }
)
