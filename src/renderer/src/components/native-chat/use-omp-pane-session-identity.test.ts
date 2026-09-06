// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcChatResolveSessionIdentityArgs,
  OmpRpcChatResolveSessionIdentityResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'

vi.mock('./use-omp-rpc-commands', () => ({
  isOmpRpcCatalogAgent: (agent: string | null) => agent === 'omp'
}))

import {
  useOmpPaneSessionIdentity,
  type UseOmpPaneSessionIdentityArgs
} from './use-omp-pane-session-identity'

const resolveSessionIdentity =
  vi.fn<
    (args: OmpRpcChatResolveSessionIdentityArgs) => Promise<OmpRpcChatResolveSessionIdentityResult>
  >()

const BASE_ARGS: UseOmpPaneSessionIdentityArgs = {
  agent: 'omp',
  paneKey: 'tab-1:leaf-1',
  ptyId: 'pty-1',
  cwd: '/work/a',
  runtimeEnvironmentId: null,
  connectionId: null,
  isVisible: true
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: { resolveSessionIdentity }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useOmpPaneSessionIdentity', () => {
  it('resolves the session id once paneKey/cwd/visibility are known', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(result.current).toBe('session-1'))
    expect(resolveSessionIdentity).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      cwd: '/work/a'
    })
  })

  // Wave 9, Defect 1: `ptyId` is an optional accuracy input, never a
  // precondition — resolution must proceed via the mtime fallback with no
  // live `ptyId` at all.
  it('resolves with no ptyId at all via the mtime fallback', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'mtime-fallback' })
    const { result } = renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, ptyId: null }))

    await waitFor(() => expect(result.current).toBe('session-1'))
    expect(resolveSessionIdentity).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      ptyId: null,
      cwd: '/work/a'
    })
  })

  it('returns null and never calls the resolver when ineligible', () => {
    const { result } = renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, paneKey: null }))
    expect(result.current).toBeNull()
    expect(resolveSessionIdentity).not.toHaveBeenCalled()

    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, agent: 'claude' }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, isVisible: false }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, runtimeEnvironmentId: 'runtime-1' }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, cwd: null }))
    expect(resolveSessionIdentity).not.toHaveBeenCalled()
  })

  // The resolver scans THIS client's omp sessions root by cwd, so a pane whose
  // cwd lives on another host must never reach it: the newest local session for
  // a same-named path belongs to a different repository entirely.
  it('never scans local disk for an ssh-owned pane, nor while the owner is unknown', () => {
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, connectionId: 'target-1' }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, connectionId: undefined }))

    expect(resolveSessionIdentity).not.toHaveBeenCalled()
  })

  it('never scans local disk for a project configured to execute in WSL', () => {
    renderHook(() =>
      useOmpPaneSessionIdentity({
        ...BASE_ARGS,
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project-1',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'wsl:Ubuntu'
          }
        }
      })
    )

    expect(resolveSessionIdentity).not.toHaveBeenCalled()
  })

  it('returns null when the resolver finds nothing to resume', async () => {
    resolveSessionIdentity.mockResolvedValue(null)
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
  })

  // Wave 9, Defect 1, acceptance criterion 1 (the deadlock this wave
  // fixes): Decision 1's acquisition kills the pane's live PTY on success,
  // nulling `ptyId`. That must never discard an already-resolved identity
  // or flip the hook back to ineligible.
  it('survives ptyId going null after acquisition kills the pty (Defect 1: no deadlock)', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    rerender({ ...BASE_ARGS, ptyId: null })

    expect(result.current).toBe('session-1')
  })

  it('upgrades an mtime fallback to the authoritative breadcrumb when the PTY appears', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({
      sessionId: 'fallback-session',
      source: 'mtime-fallback'
    })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('fallback-session'))

    resolveSessionIdentity.mockResolvedValueOnce({
      sessionId: 'breadcrumb-session',
      source: 'breadcrumb'
    })
    rerender({ ...BASE_ARGS, ptyId: 'pty-2' })
    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current).toBe('breadcrumb-session'))
  })

  it('never downgrades or swaps an authoritative breadcrumb on a later re-resolution', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    resolveSessionIdentity.mockResolvedValueOnce(null)
    rerender({ ...BASE_ARGS, ptyId: 'pty-2' })
    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(2))
    expect(result.current).toBe('session-1')

    resolveSessionIdentity.mockResolvedValueOnce({
      sessionId: 'session-9',
      source: 'mtime-fallback'
    })
    rerender({ ...BASE_ARGS, ptyId: 'pty-3' })
    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(3))
    expect(result.current).toBe('session-1')
  })

  it('re-resolves on a genuine identity rebind (paneKey change) and drops the stale value meanwhile', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    const { promise, resolve } = Promise.withResolvers<OmpRpcChatResolveSessionIdentityResult>()
    resolveSessionIdentity.mockReturnValueOnce(promise)
    rerender({ ...BASE_ARGS, paneKey: 'tab-1:leaf-2' })

    // The stale value must not leak across the identity rebind while the
    // new resolution is in flight.
    expect(result.current).toBeNull()
    resolve({ sessionId: 'session-2', source: 'mtime-fallback' })
    await waitFor(() => expect(result.current).toBe('session-2'))
    expect(resolveSessionIdentity).toHaveBeenCalledTimes(2)
  })

  it('does not re-resolve on a bare visibility toggle once already resolved', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    rerender({ ...BASE_ARGS, isVisible: false })
    rerender({ ...BASE_ARGS, isVisible: true })

    expect(result.current).toBe('session-1')
    expect(resolveSessionIdentity).toHaveBeenCalledTimes(1)
  })

  // XLR-R1-002: the sticky key must carry everything the eligibility gate reads.
  // A pane that stops being a local OMP pane has been rebound, so the id it
  // resolved belongs to the previous binding and may never be served again.
  it('drops the resolved id when the pane rebinds away from a local OMP pane', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-a', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-a'))

    rerender({ ...BASE_ARGS, runtimeEnvironmentId: 'runtime-1' })
    expect(result.current).toBeNull()

    const { promise, resolve } = Promise.withResolvers<OmpRpcChatResolveSessionIdentityResult>()
    resolveSessionIdentity.mockReturnValueOnce(promise)
    rerender(BASE_ARGS)
    // Ownership may kill the pane's PTY off this value, so the previous
    // binding's id must not leak while the new resolution is still in flight.
    expect(result.current).toBeNull()
    resolve({ sessionId: 'session-b', source: 'mtime-fallback' })
    await waitFor(() => expect(result.current).toBe('session-b'))
  })

  it('drops the resolved id when the agent rebinds away from omp and back', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-a', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-a'))

    rerender({ ...BASE_ARGS, agent: 'claude' })
    expect(result.current).toBeNull()

    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-b', source: 'breadcrumb' })
    rerender(BASE_ARGS)
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe('session-b'))
  })

  it('degrades to null when the IPC call rejects', async () => {
    resolveSessionIdentity.mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
  })
})
