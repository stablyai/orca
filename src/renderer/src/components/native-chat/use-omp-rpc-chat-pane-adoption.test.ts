// @vitest-environment happy-dom
//
// XLR-R6-004 (cross-lab review): a renderer restarted by Cmd+R or crash
// recovery keeps the null PTY binding acquisition itself wrote, while main
// still owns the RPC child. First engagement required a live `ptyId`, so the
// new document could neither subscribe to that child nor release it. Split from
// use-omp-rpc-chat-pane-ownership.test.ts, which is at its max-lines budget.

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'

const acquire = vi.fn<(args: OmpRpcChatAcquireArgs) => Promise<OmpRpcChatAcquireResult>>()
const release = vi.fn<(args: OmpRpcChatReleaseArgs) => Promise<OmpRpcChatReleaseResult>>()
const hasSession = vi.fn<(args: { paneKey: string }) => Promise<{ sessionFile: string } | null>>()
const subscribe = vi.fn(() => vi.fn())
const ptyKill = vi.fn<(id: string) => Promise<void>>()
const resolveSessionIdentity = vi.fn()

const respawnPtyForOmpRpcChatHandbackWithRetry = vi.hoisted(() => vi.fn())
const restorePtyBindingsAfterRefusedOmpRpcAcquire = vi.hoisted(() => vi.fn())
vi.mock('./omp-rpc-chat-handback', () => ({
  respawnPtyForOmpRpcChatHandbackWithRetry,
  restorePtyBindingsAfterRefusedOmpRpcAcquire
}))

import {
  useOmpRpcChatPaneOwnership,
  type UseOmpRpcChatPaneOwnershipArgs
} from './use-omp-rpc-chat-pane-ownership'
import { useOmpRpcChatAdoptableIdentity } from './use-omp-rpc-chat-pane-adoption'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

/** The pane a reload restores: RPC-owned, so its PTY binding is null. */
const RESTORED_PANE: UseOmpRpcChatPaneOwnershipArgs = {
  agent: 'omp',
  paneKey: PANE_KEY,
  ptyId: null,
  cwd: '/work/a',
  isVisible: true,
  runtimeEnvironmentId: null,
  connectionId: null
}

function status(): string | undefined {
  return useAppStore.getState().ompRpcChatOwnershipByPaneKey[PANE_KEY]?.status
}

beforeEach(() => {
  vi.clearAllMocks()
  acquire.mockResolvedValue({ ok: true })
  release.mockResolvedValue({ released: true })
  ptyKill.mockResolvedValue(undefined)
  respawnPtyForOmpRpcChatHandbackWithRetry.mockResolvedValue(undefined)
  resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
  useAppStore.setState(useAppStore.getInitialState(), true)
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: {
      resolveSessionIdentity,
      acquire,
      hasSession,
      release,
      send: vi.fn(),
      abort: vi.fn(),
      respondExtensionUi: vi.fn(),
      subscribe
    },
    pty: { kill: ptyKill }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('adopting a surviving RPC session with no PTY', () => {
  it('clears an adopted identity when a replacement pane has its own PTY', async () => {
    hasSession.mockResolvedValue({ sessionFile: 'session-a' })
    const { result, rerender } = renderHook(
      ({ paneKey, hasPty }) => useOmpRpcChatAdoptableIdentity(paneKey, hasPty),
      { initialProps: { paneKey: 'pane-a' as string | null, hasPty: false } }
    )

    await waitFor(() => expect(result.current).toBe('session-a'))
    rerender({ paneKey: 'pane-b', hasPty: true })

    expect(result.current).toBeNull()
  })

  it('engages the pane main still owns, without killing a PTY it does not have', async () => {
    hasSession.mockResolvedValue({ sessionFile: 'session-1' })
    renderHook(() => useOmpRpcChatPaneOwnership(RESTORED_PANE))

    await waitFor(() => expect(status()).toBe('acquired'))
    expect(hasSession).toHaveBeenCalledWith({ paneKey: PANE_KEY })
    expect(acquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: null,
      cwd: '/work/a',
      sessionFile: 'session-1'
    })
    // Nothing to stop, so nothing is stopped and no pre-kill mutation is made.
    expect(ptyKill).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('releases the adopted child when the pane goes away', async () => {
    hasSession.mockResolvedValue({ sessionFile: 'session-1' })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(RESTORED_PANE))
    await waitFor(() => expect(status()).toBe('acquired'))

    unmount()

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    // The hand-back still owes this pane a terminal; it just replaces nothing.
    expect(release).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: '', cwd: '/work/a', sessionId: 'session-1' }
    })
  })

  it('stays on the PTY-requiring gate when main owns nothing for the pane', async () => {
    hasSession.mockResolvedValue(null)
    renderHook(() => useOmpRpcChatPaneOwnership(RESTORED_PANE))

    await waitFor(() => expect(hasSession).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(acquire).not.toHaveBeenCalled()
    expect(status()).toBe('idle')
  })

  it('adopts main authoritative session identity over a newer disk candidate', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-b', source: 'mtime-fallback' })
    hasSession.mockResolvedValue({ sessionFile: 'session-a' })
    renderHook(() => useOmpRpcChatPaneOwnership(RESTORED_PANE))

    await waitFor(() => expect(status()).toBe('acquired'))

    expect(hasSession).toHaveBeenCalledWith({ paneKey: PANE_KEY })
    expect(acquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: null,
      cwd: '/work/a',
      sessionFile: 'session-a'
    })
  })

  it('stays on the PTY-requiring gate when the probe itself fails', async () => {
    hasSession.mockRejectedValue(new Error('ipc down'))
    renderHook(() => useOmpRpcChatPaneOwnership(RESTORED_PANE))

    await waitFor(() => expect(hasSession).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(acquire).not.toHaveBeenCalled()
  })

  it('never probes for a pane that has a PTY of its own', async () => {
    renderHook(() => useOmpRpcChatPaneOwnership({ ...RESTORED_PANE, ptyId: 'pty-1' }))

    await waitFor(() => expect(status()).toBe('acquired'))
    expect(hasSession).not.toHaveBeenCalled()
    expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
  })
})
