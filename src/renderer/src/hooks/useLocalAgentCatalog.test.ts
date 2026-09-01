// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'
import { useLocalAgentCatalog } from './useLocalAgentCatalog'

function snapshot(revision: number): LocalAgentCatalogSnapshot {
  return {
    version: 1,
    revision,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [],
    deletedCustomAgents: [],
    repairIssues: [],
    projection: { status: 'ready', bytes: 0, maxBytes: 524_288 },
    localStorage: { status: 'ready', bytes: 0, maxBytes: 16_777_216 }
  } as LocalAgentCatalogSnapshot
}

const getLocal = vi.fn<() => Promise<LocalAgentCatalogSnapshot>>()
let settingsChangedCallback: ((updates: Record<string, unknown>) => void) | null = null
let settingsSubscriptions = 0

beforeEach(() => {
  getLocal.mockReset()
  getLocal.mockResolvedValue(snapshot(1))
  settingsChangedCallback = null
  settingsSubscriptions = 0
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      agentCatalog: { getLocal },
      onChanged: (cb: (updates: Record<string, unknown>) => void) => {
        settingsSubscriptions += 1
        settingsChangedCallback = cb
        return () => {
          settingsSubscriptions -= 1
          settingsChangedCallback = null
        }
      }
    }
  }
})

afterEach(() => {
  // The catalog cache is process-wide; unmount every consumer so the next test
  // starts from an empty store rather than the previous test's snapshot.
  cleanup()
  vi.restoreAllMocks()
})

describe('useLocalAgentCatalog', () => {
  it('loads the snapshot on mount and clears the loading flag', async () => {
    const { result } = renderHook(() => useLocalAgentCatalog())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    expect(result.current.loading).toBe(false)
    expect(getLocal).toHaveBeenCalledTimes(1)
  })

  it('adopts a mutation-returned snapshot without a refetch', async () => {
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    act(() => result.current.applySnapshot(snapshot(4)))
    expect(result.current.snapshot?.revision).toBe(4)
    expect(getLocal).toHaveBeenCalledTimes(1)
  })

  it('refetches when a narrow catalog settings slice changes', async () => {
    getLocal.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2))
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))

    act(() => settingsChangedCallback?.({ defaultTuiAgent: 'codex' }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2))
    expect(getLocal).toHaveBeenCalledTimes(2)
  })

  it('refetches when custom-agent catalog settings slices change', async () => {
    getLocal
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(snapshot(2))
      .mockResolvedValueOnce(snapshot(3))
      .mockResolvedValueOnce(snapshot(4))
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))

    // Authoring mutations patch these keys; every mounted consumer must refetch.
    act(() => settingsChangedCallback?.({ customTuiAgents: [] }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2))
    act(() => settingsChangedCallback?.({ deletedCustomTuiAgents: [] }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3))
    act(() => settingsChangedCallback?.({ agentCatalogRevision: 7 }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(4))
    expect(getLocal).toHaveBeenCalledTimes(4)
  })

  it('ignores unrelated settings changes', async () => {
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    act(() => settingsChangedCallback?.({ theme: 'dark' }))
    expect(getLocal).toHaveBeenCalledTimes(1)
  })

  it('neither re-renders nor reloads when an unrelated settings slice changes', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useLocalAgentCatalog()
    })
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    const rendersAfterLoad = renders
    const snapshotRef = result.current.snapshot
    act(() => settingsChangedCallback?.({ theme: 'dark', fontSize: 14 }))
    // The catalog UI subscribes to no whole-settings store, so an unrelated slice
    // fires no setState: no reload, no re-render, stable snapshot identity (oracle 25).
    expect(getLocal).toHaveBeenCalledTimes(1)
    expect(renders).toBe(rendersAfterLoad)
    expect(result.current.snapshot).toBe(snapshotRef)
  })

  it('does not let a stale in-flight load overwrite an adopted snapshot', async () => {
    let resolveFirst: ((value: LocalAgentCatalogSnapshot) => void) | null = null
    getLocal.mockImplementationOnce(
      () => new Promise<LocalAgentCatalogSnapshot>((resolve) => (resolveFirst = resolve))
    )
    const { result } = renderHook(() => useLocalAgentCatalog())
    act(() => result.current.applySnapshot(snapshot(9)))
    // The mount load resolves late; its result must be ignored.
    act(() => resolveFirst?.(snapshot(1)))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(9))
  })
})

// P1-22: a workspace with many split groups mounts this hook a dozen-plus times.
// Each consumer used to own a full `getLocal` round-trip (megabytes of structured
// clone at a large catalog) plus its own settings listener.
describe('useLocalAgentCatalog shared store (P1-22)', () => {
  it('serves many concurrent consumers from one fetch and one settings listener', async () => {
    const { result } = renderHook(() => ({
      a: useLocalAgentCatalog(),
      b: useLocalAgentCatalog(),
      c: useLocalAgentCatalog()
    }))
    await waitFor(() => expect(result.current.a.snapshot?.revision).toBe(1))

    expect(getLocal).toHaveBeenCalledTimes(1)
    expect(settingsSubscriptions).toBe(1)
    // One cached snapshot, not one copy per consumer.
    expect(result.current.b.snapshot).toBe(result.current.a.snapshot)
    expect(result.current.c.snapshot).toBe(result.current.a.snapshot)
  })

  it('shares one refetch across separately mounted consumers', async () => {
    getLocal.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2))
    const first = renderHook(() => useLocalAgentCatalog())
    const second = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(second.result.current.snapshot?.revision).toBe(1))
    expect(getLocal).toHaveBeenCalledTimes(1)

    act(() => settingsChangedCallback?.({ agentCatalogRevision: 2 }))
    await waitFor(() => expect(first.result.current.snapshot?.revision).toBe(2))

    // One reload feeds both surfaces.
    expect(getLocal).toHaveBeenCalledTimes(2)
    expect(second.result.current.snapshot).toBe(first.result.current.snapshot)
  })

  it('keeps a disabled consumer (a closed dialog) off the store entirely', async () => {
    const { result } = renderHook(() => useLocalAgentCatalog({ enabled: false }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(getLocal).not.toHaveBeenCalled()
    expect(settingsSubscriptions).toBe(0)
    expect(result.current.snapshot).toBeNull()
    expect(result.current.unavailable).toBe(false)
  })

  it('reports unavailable instead of throwing when the host has no catalog surface', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: { onChanged: () => () => {} }
    }
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.unavailable).toBe(true))
    expect(result.current.loading).toBe(false)
  })

  it('loads once when a disabled consumer is enabled alongside an active one', async () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => ({
        always: useLocalAgentCatalog(),
        dialog: useLocalAgentCatalog({ enabled: open })
      }),
      { initialProps: { open: false } }
    )
    await waitFor(() => expect(result.current.always.snapshot?.revision).toBe(1))
    expect(result.current.dialog.snapshot).toBeNull()

    rerender({ open: true })
    // The dialog reads the already-cached snapshot; opening costs no extra fetch.
    expect(getLocal).toHaveBeenCalledTimes(1)
    expect(result.current.dialog.snapshot).toBe(result.current.always.snapshot)
  })
})
