// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult,
  OmpRpcChatResolveSessionIdentityArgs,
  OmpRpcChatResolveSessionIdentityResult,
  OmpRpcChatRespondExtensionUiArgs,
  OmpRpcChatSendArgs,
  OmpRpcChatSendResult,
  OmpRpcChatSubscribeArgs
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'

const resolveSessionIdentity =
  vi.fn<
    (args: OmpRpcChatResolveSessionIdentityArgs) => Promise<OmpRpcChatResolveSessionIdentityResult>
  >()
const acquire = vi.fn<(args: OmpRpcChatAcquireArgs) => Promise<OmpRpcChatAcquireResult>>()
const release = vi.fn<(args: OmpRpcChatReleaseArgs) => Promise<OmpRpcChatReleaseResult>>()
const send = vi.fn<(args: OmpRpcChatSendArgs) => Promise<OmpRpcChatSendResult>>()
const abort = vi.fn<(args: { paneKey: string }) => Promise<OmpRpcChatSendResult>>()
const respondExtensionUi = vi.fn<(args: OmpRpcChatRespondExtensionUiArgs) => void>()
const subscribe =
  vi.fn<
    (args: OmpRpcChatSubscribeArgs, onEvent: (event: OmpRpcClientEvent) => void) => () => void
  >()
const ptyKill = vi.fn<(id: string, opts?: { keepHistory?: boolean }) => Promise<void>>()
const respawnPtyForOmpRpcChatHandbackWithRetry = vi.hoisted(() =>
  vi.fn<
    (args: {
      paneKey: string
      replacedPtyId: string
      cwd: string
      sessionId: string
    }) => Promise<void>
  >()
)
const restorePtyBindingsAfterRefusedOmpRpcAcquire = vi.hoisted(() => vi.fn())

// Why: use-omp-rpc-chat-pane-ownership.ts (via omp-rpc-acquire-failure-pty-
// recovery.ts) calls these directly for the D1 restore-a-PTY fix — mocked so
// these tests assert the call rather than exercising the real store/layout
// rebind machinery covered by omp-rpc-chat-handback.test.ts. Both imported
// exports are mocked: a factory that omits one makes the recovery path throw.
vi.mock('./omp-rpc-chat-handback', () => ({
  respawnPtyForOmpRpcChatHandbackWithRetry,
  restorePtyBindingsAfterRefusedOmpRpcAcquire
}))

import {
  isOmpRpcChatSessionEligible,
  useOmpRpcChatPaneOwnership,
  type UseOmpRpcChatPaneOwnershipArgs
} from './use-omp-rpc-chat-pane-ownership'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

const BASE_ARGS: UseOmpRpcChatPaneOwnershipArgs = {
  agent: 'omp',
  paneKey: PANE_KEY,
  ptyId: 'pty-1',
  cwd: '/work/a',
  isVisible: true,
  runtimeEnvironmentId: null,
  connectionId: null
}

function ownershipEntry(paneKey: string = PANE_KEY) {
  return useAppStore.getState().ompRpcChatOwnershipByPaneKey[paneKey]
}

beforeEach(() => {
  vi.clearAllMocks()
  release.mockResolvedValue({ released: true })
  subscribe.mockReturnValue(vi.fn())
  ptyKill.mockResolvedValue(undefined)
  respawnPtyForOmpRpcChatHandbackWithRetry.mockResolvedValue(undefined)
  resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
  // Why: killPtyBeforeOmpRpcAcquire (Critical A) touches the real store —
  // reset it so one test's suppression/pty-binding state never leaks into
  // the next.
  useAppStore.setState(useAppStore.getInitialState(), true)
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: {
      resolveSessionIdentity,
      acquire,
      release,
      send,
      abort,
      respondExtensionUi,
      subscribe
    },
    pty: { kill: ptyKill }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useOmpRpcChatPaneOwnership — execution-host locality', () => {
  it('never touches the PTY or local disk for an ssh-owned pane (execution boundary rule 1)', () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, connectionId: 'target-1' }))

    expect(resolveSessionIdentity).not.toHaveBeenCalled()
    expect(ptyKill).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('never touches the PTY or local disk while the owning host is unresolved', () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, connectionId: undefined }))

    expect(resolveSessionIdentity).not.toHaveBeenCalled()
    expect(ptyKill).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('never touches the host PTY or session root for a WSL project pane', () => {
    renderHook(() =>
      useOmpRpcChatPaneOwnership({
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
    expect(ptyKill).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  // The web client's `window.api` is a bridge to the paired runtime, which owns
  // every process — so RPC ownership was never available here. Publishing
  // 'spawn-failed' claimed a local spawn had been tried and had failed; the
  // pane simply has no local execution host to spawn on.
  it('stays idle on the web client instead of reporting a spawn failure', async () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    try {
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ownershipEntry()?.status).toBe('idle'))
      expect(resolveSessionIdentity).not.toHaveBeenCalled()
      expect(acquire).not.toHaveBeenCalled()
    } finally {
      delete (window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    }
  })
})

describe('isOmpRpcChatSessionEligible', () => {
  it('requires every gate: visible, omp, local, a paneKey, and a known cwd/session', () => {
    expect(
      isOmpRpcChatSessionEligible({
        agent: 'omp',
        isVisible: true,
        runtimeEnvironmentId: null,
        connectionId: null,
        paneKey: PANE_KEY,
        cwd: '/work/a',
        sessionFile: 'session-1'
      })
    ).toBe(true)
  })

  // Wave 9, Defect 1 (standing rule): `ptyId` deliberately never gates
  // this — Decision 1's acquisition kills it on success, so a live `ptyId`
  // is not, and must never become, a precondition for eligibility.
  it('stays eligible with no live ptyId', () => {
    expect(
      isOmpRpcChatSessionEligible({
        agent: 'omp',
        isVisible: true,
        runtimeEnvironmentId: null,
        connectionId: null,
        paneKey: PANE_KEY,
        cwd: '/work/a',
        sessionFile: 'session-1'
      })
    ).toBe(true)
  })

  it.each([
    { isVisible: false },
    { agent: 'claude' as const },
    { runtimeEnvironmentId: 'runtime-1' },
    // Locality, not runtime ownership: an `ssh:` worktree has no runtime owner,
    // so the old `runtimeEnvironmentId === null` proxy admitted it.
    { connectionId: 'target-1' },
    // "Who owns this worktree" not yet answerable is its own verdict; assuming
    // local here would scan this client's disk for a remote cwd.
    { connectionId: undefined },
    { paneKey: null },
    { cwd: null },
    { sessionFile: null }
  ])('fails closed when %o overrides an otherwise-eligible pane', (overrides) => {
    expect(
      isOmpRpcChatSessionEligible({
        agent: 'omp',
        isVisible: true,
        runtimeEnvironmentId: null,
        connectionId: null,
        paneKey: PANE_KEY,
        cwd: '/work/a',
        sessionFile: 'session-1',
        ...overrides
      })
    ).toBe(false)
  })
})
