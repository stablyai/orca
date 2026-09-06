// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OmpRpcChatAcquireArgs, OmpRpcChatAcquireResult, OmpRpcChatReleaseArgs, OmpRpcChatReleaseResult, OmpRpcChatResolveSessionIdentityArgs, OmpRpcChatResolveSessionIdentityResult, OmpRpcChatRespondExtensionUiArgs, OmpRpcChatSendArgs, OmpRpcChatSendResult, OmpRpcChatSubscribeArgs } from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'

const resolveSessionIdentity = vi.fn<(args: OmpRpcChatResolveSessionIdentityArgs) => Promise<OmpRpcChatResolveSessionIdentityResult>>()
const acquire = vi.fn<(args: OmpRpcChatAcquireArgs) => Promise<OmpRpcChatAcquireResult>>()
const release = vi.fn<(args: OmpRpcChatReleaseArgs) => Promise<OmpRpcChatReleaseResult>>()
const send = vi.fn<(args: OmpRpcChatSendArgs) => Promise<OmpRpcChatSendResult>>()
const abort = vi.fn<(args: { paneKey: string }) => Promise<OmpRpcChatSendResult>>()
const respondExtensionUi = vi.fn<(args: OmpRpcChatRespondExtensionUiArgs) => void>()
const subscribe = vi.fn<(args: OmpRpcChatSubscribeArgs, onEvent: (event: OmpRpcClientEvent) => void) => () => void>()
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

const restorePtyBindingsAfterRefusedOmpRpcAcquire = vi.hoisted(() =>
  vi.fn<(args: { paneKey: string; ptyId: string }) => void>()
)

// Why: use-omp-rpc-chat-pane-ownership.ts calls these directly for the D1
// restore-a-PTY fix (a failed acquire after the kill above must never leave
// the pane with neither a live terminal nor an RPC session) — mocked so
// these tests assert the call rather than exercising the real store/layout
// rebind machinery covered by omp-rpc-chat-handback.test.ts.
vi.mock('./omp-rpc-chat-handback', () => ({
  respawnPtyForOmpRpcChatHandbackWithRetry,
  restorePtyBindingsAfterRefusedOmpRpcAcquire
}))

import {
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

/** Consumes the pane's current notice the way a composer does: the clear
 *  names what it read, so a newer unread failure is never erased. */
function clearReadFailure(paneKey: string = PANE_KEY) {
  const current = ownershipEntry(paneKey)
  useAppStore
    .getState()
    .clearOmpRpcChatPaneCommandFailure(paneKey, { id: current?.commandFailureId ?? 0 })
}

/** Delivers the fatal frame kind under test through the pane's live
 *  subscription — both kinds land on the same `onFatalFrame` path. */
function emitFatalFrame(kind: 'protocol-fault' | 'exit'): void {
  act(() => {
    lastSubscribedListener()(
      kind === 'protocol-fault'
        ? { kind: 'protocol-fault', message: 'boom' }
        : { kind: 'exit', code: 1, signal: null }
    )
  })
}

function lastSubscribedListener(): (event: OmpRpcClientEvent) => void {
  const call = subscribe.mock.calls.at(-1)
  if (!call) {
    throw new Error('subscribe was never called')
  }
  return call[1]
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

describe('useOmpRpcChatPaneOwnership', () => {
  it('acquires, subscribes, and feeds pushed frames through the turn reducer', async () => {
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    expect(ownershipEntry()?.resolvedSessionId).toBe('session-1')
    // Decision 1: the pane's PTY is killed before acquiring — the trigger
    // that closes the "no live pane ever acquires" gate — and keeps
    // scrollback for the eventual hand-back.
    expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
    expect(ptyKill.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0])
    expect(acquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1',
      cwd: '/work/a',
      sessionFile: 'session-1'
    })
    expect(subscribe).toHaveBeenCalledTimes(1)

    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(ownershipEntry()?.turnState.status).toBe('working')
  })

  it('still acquires when the kill call rejects (best-effort — the registry liveness gate is the real proof)', async () => {
    ptyKill.mockRejectedValue(new Error('already gone'))
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('passes the configured OMP launch override into acquisition', async () => {
    useAppStore.setState({
      settings: { agentCmdOverrides: { omp: '"/opt/omp-v2/bin/omp" --protocol v2' } } as never
    })
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    expect(acquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1',
      cwd: '/work/a',
      sessionFile: 'session-1',
      agentCommand: '"/opt/omp-v2/bin/omp" --protocol v2'
    })
  })

  it.each(['live', 'unverifiable', 'conflict', 'spawn-failed', 'executable-not-found'] as const)(
    'degrades to the PTY path exactly as today when acquire returns "%s"',
    async (reason) => {
      acquire.mockResolvedValue({ ok: false, reason })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ownershipEntry()?.status).toBe(reason))
      expect(subscribe).not.toHaveBeenCalled()
      // The degraded pane's own turn state never leaves idle/empty, so any
      // overlay/status-override consumer sees exactly today's behavior.
      expect(ownershipEntry()?.turnState.status).toBe('idle')
    }
  )

  // D1 fix (wave 7 / Bug 1): the original "degrades to the PTY path" test
  // above only proves the store status flips — it never proves a PTY comes
  // back. `killPtyBeforeOmpRpcAcquire` above already killed the pane's live
  // PTY by the time any of these reasons come back, and a bare
  // `api.release({respawn})` is a no-op here (the registry never stored a
  // session to release), so without this fix the pane is left with neither
  // a live terminal nor an RPC session — exactly the "broken pane" outcome
  // the wave-4 review warned about.
  it.each(['spawn-failed', 'executable-not-found'] as const)(
    'restores a PTY directly when acquire returns "%s" after the kill (D1: never neither terminal nor session)',
    async (reason) => {
      acquire.mockResolvedValue({ ok: false, reason })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ownershipEntry()?.status).toBe(reason))
      expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
      expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        replacedPtyId: 'pty-1',
        cwd: '/work/a',
        sessionId: 'session-1'
      })
      // Never the registry-mediated release path: nothing was ever
      // acquired, so that call would silently no-op (released: false) and
      // never fire the handback push the direct call above bypasses.
      expect(release).not.toHaveBeenCalled()
      // A respawn re-binds the pane itself, so the pre-kill undo must stay
      // out of its way (XLR-006) — restoring the dead id over the fresh one
      // would point the leaf back at the process the respawn just replaced.
      expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).not.toHaveBeenCalled()
    }
  )

  // XLR-047 (cross-lab review): `conflict` used to be restored alongside the
  // two reasons above, on the reading that it means "no RPC writer ever
  // started". It does not — it means someone else holds the session's claim: a
  // release that failed closed keeps its (possibly streaming) child, and a
  // second pane racing for the same session holds a live claim of its own.
  // Resuming `omp --resume` beside either is the single-writer violation this
  // feature is proof-gated to prevent, while the pane's own PTY is by then
  // provably gone, so the pre-kill undo has nothing live to point back at.
  it('never respawns a PTY when acquire returns "conflict" after the kill (XLR-047)', async () => {
    acquire.mockResolvedValue({ ok: false, reason: 'conflict' })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('conflict'))
    expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).not.toHaveBeenCalled()
  })

  // XLR-001 (cross-lab review): 'live' and 'unverifiable' are main's own
  // liveness verdict on the exact PTY the kill above targeted, and neither
  // is proof it exited — 'live' says the kill did NOT take. These two used
  // to restore alongside the reasons above, which put a second
  // `omp --resume` on the session file next to a child still writing it.
  // The pane keeps the terminal it never actually lost; only a refusal that
  // leaves the PTY provably gone owes it a replacement.
  it.each(['live', 'unverifiable'] as const)(
    'never respawns a second PTY when acquire returns "%s" (single-writer invariant)',
    async (reason) => {
      acquire.mockResolvedValue({ ok: false, reason })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ownershipEntry()?.status).toBe(reason))
      expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
      expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
      // XLR-006: keeping the terminal it never lost also means keeping the
      // renderer's record of it — the pre-kill suppression and binding
      // erasure must be undone, not just left un-respawned.
      expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        ptyId: 'pty-1'
      })
    }
  )

  it('never respawns when the pre-acquire kill itself threw (no evidence the PTY is gone)', async () => {
    ptyKill.mockRejectedValue(new Error('pty kill failed'))
    acquire.mockResolvedValue({ ok: false, reason: 'spawn-failed' })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('spawn-failed'))
    expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1'
    })
  })

  // XLR-001, same root cause as the throw above: "reached the end of the
  // kill helper" is not the same fact as "the stop was accepted". An absent
  // pty surface stops nothing, so it must not entitle a second
  // `omp --resume` against the session the untouched PTY still holds.
  it('never respawns when the pty kill surface is unavailable (no stop, no evidence)', async () => {
    ;(window as unknown as { api: { pty?: unknown } }).api.pty = undefined
    acquire.mockResolvedValue({ ok: false, reason: 'spawn-failed' })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('spawn-failed'))
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1'
    })
  })

  it('restores a PTY when a StrictMode/rebind race cancels the pane before a delayed acquire fails', async () => {
    const { promise, resolve: resolveAcquire } = Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValue(promise)
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ptyKill).toHaveBeenCalledTimes(1))

    unmount()
    resolveAcquire({ ok: false, reason: 'spawn-failed' })
    await waitFor(() => expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledTimes(1))

    expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1'
    })
  })

  // XLR-015 (cross-lab review): the pane was cancelled while the pre-acquire
  // kill was still round-tripping through main. Dispatching the acquire anyway
  // spawns an RPC child that no live effect is left holding the release for —
  // and the effect's own cleanup already ran, so nothing retires it.
  it('never acquires when the pane is cancelled while the pre-acquire kill is in flight', async () => {
    const { promise, resolve: resolveKill } = Promise.withResolvers<void>()
    ptyKill.mockReturnValue(promise)
    acquire.mockResolvedValue({ ok: true })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ptyKill).toHaveBeenCalledTimes(1))

    unmount()
    resolveKill()
    await waitFor(() => expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledTimes(1))

    expect(acquire).not.toHaveBeenCalled()
    // The stop landed, so the pane is owed the PTY it lost — the same closed
    // decision a refused acquire earns.
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1'
    })
  })

  it('never kills or restores a PTY when identity never resolves (refuses to acquire, D1 gate)', () => {
    resolveSessionIdentity.mockResolvedValue(null)
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    expect(ptyKill).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
  })

  it('never acquires for a non-omp agent, a hidden pane, a runtime-owned pane, or no chat leaf yet', () => {
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, agent: 'claude' }))
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, isVisible: false }))
    renderHook(() =>
      useOmpRpcChatPaneOwnership({ ...BASE_ARGS, runtimeEnvironmentId: 'runtime-1' })
    )
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, paneKey: null }))

    expect(acquire).not.toHaveBeenCalled()
  })

  // W6-2: this hook is mounted at TerminalPane, which stays mounted through
  // an ordinary Chat<->Terminal toggle — real unmount only ever means pane
  // close, tab close, or app quit. `rerender()` remains the correct model
  // for the toggle itself (it never unmounts this hook); see the F9 test
  // below for that transition and the trap note in docs/omp-rpc-chat-adapter-plan.md
  // for why the two must never be confused.
  it('releases, unsubscribes, and clears the store entry on unmount (pane/tab close)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const unsubscribe = vi.fn()
    subscribe.mockReturnValue(unsubscribe)
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
    expect(ownershipEntry()).toBeUndefined()
  })

  // F9: a visibility toggle (Chat -> Terminal and back) must never abort or
  // release an already-acquired session — only unmount, pane close, or a
  // genuine identity rebind may release. This is the real transition for
  // this hook now (TerminalPane stays mounted through it), so `rerender()`
  // is the correct model, not `unmount()`.
  it('holds the acquired session across a visibility toggle (view-away then back)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    rerender({ ...BASE_ARGS, isVisible: false })
    rerender({ ...BASE_ARGS, isVisible: true })

    expect(ownershipEntry()?.status).toBe('acquired')
    expect(release).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  // Wave 9, Defect 1, acceptance criterion 5 (the deadlock this wave
  // fixes): Decision 1's own acquisition kills the pane's live PTY on
  // success, nulling `ptyId` out from under this hook. That must never be
  // read as an identity rebind — ownership must stay 'acquired', never
  // release, and never re-acquire, and no respawn/handback machinery may
  // fire for a session that never actually died.
  it('holds the acquired session when ptyId goes null after its own kill (Defect 1: no deadlock)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(ownershipEntry()?.turnState.status).toBe('working')

    // Models Decision 1's own effect: `clearTabPtyId` nulls the pane's
    // ptyId as a side effect of the very acquisition this hook drove.
    rerender({ ...BASE_ARGS, ptyId: null })

    expect(ownershipEntry()?.status).toBe('acquired')
    expect(ownershipEntry()?.turnState.status).toBe('working')
    expect(release).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
  })

  // A genuine identity rebind (a different cwd — e.g. the pane's split
  // target changed) must still release and re-acquire exactly as before;
  // only `ptyId` churn on its own is exempted (Defect 1).
  it('resets turn state and re-acquires on a genuine identity rebind (cwd change)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(ownershipEntry()?.turnState.status).toBe('working')

    rerender({ ...BASE_ARGS, cwd: '/work/b' })

    expect(release).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
    expect(acquire).toHaveBeenLastCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1',
      cwd: '/work/b',
      sessionFile: 'session-1'
    })
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
  })

  it('never leaks a session acquired after unmount already ran', async () => {
    const { promise, resolve: resolveAcquire } = Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValue(promise)
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    // Wait for the async identity resolution + pty-kill sequence to reach
    // the acquire call itself, so unmount genuinely races an in-flight
    // acquisition rather than firing before it ever started.
    await waitFor(() => expect(acquire).toHaveBeenCalled())
    unmount()
    resolveAcquire({ ok: true })
    await waitFor(() =>
      expect(release).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
      })
    )
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('routes send/abort through the store actions and fails closed when not acquired', async () => {
    acquire.mockResolvedValue({ ok: false, reason: 'live' })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('live'))

    const sendResult = await useAppStore
      .getState()
      .sendOmpRpcChatPane(PANE_KEY, { message: 'hi', behavior: 'idle' })
    const abortResult = await useAppStore.getState().abortOmpRpcChatPane(PANE_KEY)

    expect(sendResult.ok).toBe(false)
    expect(abortResult.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it('sends and aborts through the API once acquired, keyed by paneKey alone', async () => {
    acquire.mockResolvedValue({ ok: true })
    send.mockResolvedValue({ ok: true, agentInvoked: true })
    abort.mockResolvedValue({ ok: true, agentInvoked: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, { message: 'hi', behavior: 'steer' })
    await useAppStore.getState().abortOmpRpcChatPane(PANE_KEY)

    expect(send).toHaveBeenCalledWith({ paneKey: PANE_KEY, message: 'hi', behavior: 'steer' })
    expect(abort).toHaveBeenCalledWith({ paneKey: PANE_KEY })
  })

  it('drops a send whose expected generation the pane has already rebound past', async () => {
    // A queued command carries the generation it was dispatched on. The ref
    // that mirrors the live generation belongs to a Chat-view hook that may be
    // unmounted by now, so this store check is the only one that still sees a
    // rebind.
    acquire.mockResolvedValue({ ok: true })
    send.mockResolvedValue({ ok: true, agentInvoked: false })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    const generation = ownershipEntry()?.generation ?? 0
    // The command route is also gated on the live catalog proving the session
    // runs `/help`, so publish one and isolate the generation fence.
    act(() => {
      lastSubscribedListener()({ kind: 'commands', commands: [{ name: 'help' }] })
    })

    const stale = await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, {
      message: '/help',
      behavior: 'command',
      expectedGeneration: generation - 1
    })

    expect(stale.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()

    const current = await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, {
      message: '/help',
      behavior: 'command',
      expectedGeneration: generation
    })

    expect(current.ok).toBe(true)
    // The fence is renderer-side bookkeeping; it must not reach the wire.
    expect(send).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      message: '/help',
      behavior: 'command'
    })
  })

  it('never reuses a cleared pane generation for a replacement session', async () => {
    acquire.mockResolvedValue({ ok: true })
    send.mockResolvedValue({ ok: true, agentInvoked: false })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    const originalGeneration = ownershipEntry()?.generation

    act(() => {
      useAppStore.getState().clearOmpRpcChatPaneOwnership(PANE_KEY)
      useAppStore.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    })

    expect(ownershipEntry()?.generation).toBeGreaterThan(originalGeneration ?? 0)
    const stale = await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, {
      message: '/help',
      behavior: 'command',
      expectedGeneration: originalGeneration
    })

    expect(stale.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('preserves a queued command failure for the replacement chat surface', async () => {
    // The Chat <-> Terminal toggle this notice exists for unmounts the
    // composer but never the pane-anchored owner, so the row is still live
    // when the rejection lands and the remounted surface reads it off the pane.
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    act(() => {
      useAppStore.getState().reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/help')
    })

    expect(ownershipEntry()?.commandFailureMessage).toBe(
      'Command /help could not be sent to the agent.'
    )
    expect(ownershipEntry()?.status).toBe('acquired')
  })

  it('never resurrects an ownership row the pane owner has released', async () => {
    // Pane/tab close drops the row for good. A send rejected afterwards has no
    // surface left to show the notice and none left to clear it, so recreating
    // the row would strand it for the renderer's life and replay it at
    // whatever later session reuses this pane key.
    acquire.mockResolvedValue({ ok: true })
    const hook = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    hook.unmount()
    await waitFor(() => expect(ownershipEntry()).toBeUndefined())

    act(() => {
      useAppStore.getState().reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/help')
      useAppStore.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY)
    })

    expect(ownershipEntry()).toBeUndefined()
  })

  it("attributes a superseded session's failure to the rebind, never to the row that replaced it", async () => {
    // The row can be replaced rather than merely absent: the pane identity
    // rebinds, the old row is cleared, and a new session acquires the same
    // paneKey. A queued command from the old session is then correctly refused,
    // and paneKey alone cannot tell the two sessions apart — but dropping the
    // notice is not the answer either. The draft was already consumed and an
    // owned pane has no PTY to retype it into, so silence is the worse of the
    // two failures. The notice lands in the pane the user is still looking at,
    // worded so the replacement session is not blamed for a send it never made.
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    const supersededGeneration = ownershipEntry()?.generation ?? 0

    act(() => {
      useAppStore.getState().clearOmpRpcChatPaneOwnership(PANE_KEY)
      useAppStore.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    })
    const replacementGeneration = ownershipEntry()?.generation ?? 0
    expect(replacementGeneration).toBeGreaterThan(supersededGeneration)

    act(() => {
      useAppStore
        .getState()
        .reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/help', supersededGeneration)
    })
    expect(ownershipEntry()?.commandFailureMessage).toBe(
      "Command /help was not sent: the pane's agent session was replaced first."
    )
    // The live session must never be described as having refused it.
    expect(ownershipEntry()?.commandFailureMessage).not.toBe(
      'Command /help could not be sent to the agent.'
    )

    // The live session's own rejected command still reports as its own.
    act(() => {
      clearReadFailure()
      useAppStore
        .getState()
        .reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/help', replacementGeneration)
    })
    expect(ownershipEntry()?.commandFailureMessage).toBe(
      'Command /help could not be sent to the agent.'
    )
  })

  it('lets a superseded notice yield to one the live session is already waiting to show', async () => {
    // The row holds one notice field, so delivering the superseded report can
    // now overwrite. Order between the two reports is arbitrary — the old
    // session's rejection and the new session's own can settle either way
    // round — and while Chat is unmounted nothing consumes the field in
    // between. The live session's failure is the one the user is about to act
    // on, so it takes the field; the superseded report yields rather than
    // relabelling a live failure as somebody else's rebind.
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    const supersededGeneration = ownershipEntry()?.generation ?? 0

    act(() => {
      useAppStore.getState().clearOmpRpcChatPaneOwnership(PANE_KEY)
      useAppStore.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    })
    const replacementGeneration = ownershipEntry()?.generation ?? 0

    act(() => {
      useAppStore
        .getState()
        .reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/deploy', replacementGeneration)
      useAppStore
        .getState()
        .reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/help', supersededGeneration)
    })

    expect(ownershipEntry()?.commandFailureMessage).toBe(
      'Command /deploy could not be sent to the agent.'
    )
  })

  it("lets the live session's failure replace a superseded notice nobody has read yet", async () => {
    // The reverse order must not strand the more relevant notice: the field is
    // free as far as the user is concerned until a composer renders it.
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    const supersededGeneration = ownershipEntry()?.generation ?? 0

    act(() => {
      useAppStore.getState().clearOmpRpcChatPaneOwnership(PANE_KEY)
      useAppStore.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    })
    const replacementGeneration = ownershipEntry()?.generation ?? 0

    act(() => {
      useAppStore.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, supersededGeneration)
    })
    expect(ownershipEntry()?.commandFailureMessage).toBe(
      "Message was not sent: the pane's agent session was replaced first."
    )

    act(() => {
      useAppStore.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, replacementGeneration)
    })
    expect(ownershipEntry()?.commandFailureMessage).toBe('Message could not be sent to the agent.')
  })

  it('refuses a command the live catalog no longer publishes, at an unchanged generation', async () => {
    // `available_commands_update` republishes without a rebind, so the
    // generation gate cannot catch a command that stopped being executable
    // while it sat in the pane's queue. OMP hands anything its lookup misses
    // to the model, so the send is refused here instead.
    acquire.mockResolvedValue({ ok: true })
    send.mockResolvedValue({ ok: true, agentInvoked: false })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    const generation = ownershipEntry()?.generation
    const publish = (names: string[]): void => {
      act(() => {
        lastSubscribedListener()({ kind: 'commands', commands: names.map((name) => ({ name })) })
      })
    }

    publish(['help', 'deploy'])
    const proven = await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, {
      message: '/deploy prod',
      behavior: 'command',
      expectedGeneration: generation
    })
    expect(proven.ok).toBe(true)

    publish(['help'])
    expect(ownershipEntry()?.generation).toBe(generation)
    send.mockClear()
    const refused = await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, {
      message: '/deploy prod',
      behavior: 'command',
      expectedGeneration: generation
    })

    expect(refused.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    // Only the command verb is gated: ordinary chat is meant for the model.
    const chat = await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, {
      message: '/deploy prod',
      behavior: 'idle',
      expectedGeneration: generation
    })
    expect(chat.ok).toBe(true)
  })

  it('preserves a rejected plain message for the replacement chat surface', async () => {
    // Ordinary sends unmount the same way commands do: the Chat -> Terminal
    // toggle drops the composer's local notice, so the pane has to hold it.
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    act(() => {
      useAppStore.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY)
    })

    expect(ownershipEntry()?.commandFailureMessage).toBe('Message could not be sent to the agent.')
    act(() => {
      clearReadFailure()
    })
    expect(ownershipEntry()?.commandFailureMessage).toBeNull()
  })

  it("attributes a superseded session's rejected message to the rebind, not to the replacement", async () => {
    // A plain message rebinds exactly as a command does: the old row is
    // cleared, a new session takes the same paneKey, and the earlier send's
    // rejection lands afterwards. paneKey alone cannot scope it, so the notice
    // must not read as the replacement composer's own refusal — but it must
    // still be delivered, because the message the user typed never reached any
    // agent and the pane is the only surface left to say so.
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    const supersededGeneration = ownershipEntry()?.generation ?? 0

    act(() => {
      useAppStore.getState().clearOmpRpcChatPaneOwnership(PANE_KEY)
      useAppStore.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    })
    const replacementGeneration = ownershipEntry()?.generation ?? 0
    expect(replacementGeneration).toBeGreaterThan(supersededGeneration)

    act(() => {
      useAppStore.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, supersededGeneration)
    })
    expect(ownershipEntry()?.commandFailureMessage).toBe(
      "Message was not sent: the pane's agent session was replaced first."
    )
    expect(ownershipEntry()?.commandFailureMessage).not.toBe(
      'Message could not be sent to the agent.'
    )

    // The live session's own rejected message still reports as its own.
    act(() => {
      clearReadFailure()
      useAppStore.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, replacementGeneration)
    })
    expect(ownershipEntry()?.commandFailureMessage).toBe('Message could not be sent to the agent.')
  })

  it('answers extension UI by dispatching the reducer action and forwarding the reply', async () => {
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'req-1', method: 'confirm' }
      })
    })
    expect(ownershipEntry()?.turnState.pendingExtensionUiRequest?.id).toBe('req-1')

    act(() => {
      useAppStore.getState().respondOmpRpcChatExtensionUi(PANE_KEY, {
        type: 'extension_ui_response',
        id: 'req-1',
        confirmed: true
      })
    })

    expect(respondExtensionUi).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      response: { type: 'extension_ui_response', id: 'req-1', confirmed: true }
    })
    expect(ownershipEntry()?.turnState.pendingExtensionUiRequest).toBeNull()
  })

  // F3 (HIGH): a protocol-fault or exit frame mid-turn must flip status away
  // from 'acquired' and release the dead session so the caller's send path
  // falls back to PTY, instead of staying stuck claiming a session that will
  // never stream another frame.
  it.each(['protocol-fault', 'exit'] as const)(
    'flips to faulted and releases on a "%s" frame',
    async (kind) => {
      acquire.mockResolvedValue({ ok: true })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

      act(() => {
        lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
      })
      act(() => {
        lastSubscribedListener()({
          kind: 'message-update',
          frame: {
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
          }
        })
      })
      emitFatalFrame(kind)

      expect(ownershipEntry()?.status).toBe('faulted')
      // The release carries the pane's respawn context so the fallback this
      // status advertises has a terminal to fall back to — asserted in full
      // by the hand-back describe below.
      await waitFor(() =>
        expect(release).toHaveBeenCalledWith({
          paneKey: PANE_KEY,
          respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
        })
      )

      const sendResult = await useAppStore
        .getState()
        .sendOmpRpcChatPane(PANE_KEY, { message: 'hi', behavior: 'idle' })
      expect(sendResult.ok).toBe(false)
      expect(send).not.toHaveBeenCalled()
    }
  )

  // F5 (HIGH): a conflict is very often the release-in-flight or
  // StrictMode-double-mount race — retry once with bounded backoff before
  // surfacing failure.
  it('retries once on an acquire "conflict" and succeeds on the retry', async () => {
    acquire.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    acquire.mockResolvedValueOnce({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  // F7 (MEDIUM): a rejected acquire IPC call must degrade to a fail-closed
  // status, never an unhandled rejection that leaves status pinned at
  // 'pending' forever.
  it('degrades to a fail-closed status when acquire rejects', async () => {
    acquire.mockRejectedValue(new Error('ipc channel not registered'))
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('spawn-failed'))
  })

  // Critical A (cross-lab review, wave 5): killPtyBeforeOmpRpcAcquire used
  // to kill the pane's live PTY without suppressing the exit, so the
  // eventual pty:exit landed on pty-exit-hibernate.ts's "process died"
  // teardown instead of its suppressed branch — closing the whole tab for
  // the common single-pane case. Suppressing (and proactively clearing the
  // tab's pty binding to a well-defined "RPC-owned, no PTY" state) routes
  // that later, real exit to the suppressed branch instead — no tab-close
  // path is reachable from a suppressed exit.
  describe('Critical A — suppressing the pty exit before kill', () => {
    beforeEach(() => {
      useAppStore.setState({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreeId: 'wt-1',
              title: null,
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              launchAgent: 'omp' as const
            }
          ]
        } as never,
        ptyIdsByTabId: { 'tab-1': ['pty-1'] }
      })
    })

    it('suppresses the exit and clears the tab pty binding before killing', async () => {
      acquire.mockResolvedValue({ ok: true })
      let suppressedBeforeKill = false
      let clearedBeforeKill = false
      ptyKill.mockImplementation(async () => {
        suppressedBeforeKill = useAppStore.getState().suppressedPtyExitIds['pty-1'] === true
        clearedBeforeKill = useAppStore.getState().tabsByWorktree['wt-1']?.[0]?.ptyId === null
      })

      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ptyKill).toHaveBeenCalled())
      expect(suppressedBeforeKill).toBe(true)
      expect(clearedBeforeKill).toBe(true)
      // Left ARMED, not self-consumed: onExit itself must be the one to
      // consume it once the real exit round-trips back — self-consuming
      // here would leave that later, real exit unsuppressed and fall
      // through to the tab-close bug this suppression exists to prevent.
      expect(useAppStore.getState().suppressedPtyExitIds['pty-1']).toBe(true)
    })
  })

  // D1/D2 stale-record fix (wave 10): killPtyBeforeOmpRpcAcquire must clear
  // the layout leaf's ptyIdsByLeafId entry too, not only the tab record —
  // otherwise a pane whose eventual restore also fails keeps advertising a
  // leaf pty id whose process is already gone.
  describe('Critical A — clearing the layout leaf binding before kill', () => {
    it('clears terminalLayoutsByTabId[tab].ptyIdsByLeafId for the killed pty before kill resolves', async () => {
      acquire.mockResolvedValue({ ok: true })
      useAppStore.setState({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreeId: 'wt-1',
              title: null,
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              launchAgent: 'omp' as const
            }
          ]
        } as never,
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
            activeLeafId: '11111111-1111-4111-8111-111111111111',
            expandedLeafId: null,
            ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'pty-1' }
          }
        }
      })
      let leafClearedBeforeKill = false
      ptyKill.mockImplementation(async () => {
        leafClearedBeforeKill =
          useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId === undefined
      })

      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ptyKill).toHaveBeenCalled())
      expect(leafClearedBeforeKill).toBe(true)
      expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toBeUndefined()
    })
  })

  // D1 restore reliability (wave 10 root cause): wave 7's restore call sat
  // AFTER the generation-supersede check, so a run whose kill genuinely
  // happened but whose own acquire settled only after a later run had
  // already started for the same identity (a real re-acquire's race —
  // "toggling to Chat a second time" per the wave 10 brief) skipped
  // restoring the PTY it killed entirely, leaving the pane with neither a
  // terminal nor an RPC session. The fix moves the restore attempt before
  // that check; this reproduces the exact race and proves it now restores.
  describe('D1 restore reliability (wave 10)', () => {
    it('restores the PTY a superseded run killed while the later run holds no session yet', async () => {
      const { promise: firstAcquire, resolve: resolveFirstAcquire } =
        Promise.withResolvers<OmpRpcChatAcquireResult>()
      acquire.mockReturnValueOnce(firstAcquire)
      // Cycle 2 is still pursuing its own acquire, so nothing else has given
      // this pane a session — the exact case the pre-fence restore exists for.
      acquire.mockReturnValueOnce(Promise.withResolvers<OmpRpcChatAcquireResult>().promise)
      const { rerender } = renderHook(
        (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
        { initialProps: BASE_ARGS }
      )
      // Cycle 1's kill has run and its acquire call is in flight (unsettled).
      await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))
      expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })

      // A genuine identity rebind (cwd changes) starts cycle 2 for the same
      // pane while cycle 1's acquire call is still pending.
      rerender({ ...BASE_ARGS, cwd: '/work/b' })
      await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))

      // Cycle 1's own acquire now settles, as a failure, after cycle 2
      // already owns the identity.
      resolveFirstAcquire({ ok: false, reason: 'spawn-failed' })

      await waitFor(() =>
        expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledWith({
          paneKey: PANE_KEY,
          replacedPtyId: 'pty-1',
          cwd: '/work/a',
          sessionId: 'session-1'
        })
      )
      // Cycle 2's own status must survive untouched — the superseded cycle 1
      // restores its own PTY but never publishes status.
      expect(ownershipEntry()?.status).toBe('pending')
    })

    // XLR-010 (cross-lab review): the same race, except cycle 2 ACQUIRED. The
    // hand-back helpers fence on the tab generation and accept an unbound leaf,
    // and an RPC-owned pane's leaf is unbound by design — so the superseded
    // run's respawn would bind the OLD session's PTY into a pane the newer RPC
    // session owns, redirecting it away from a session that is still acquired
    // and can no longer hand back through its expected binding.
    it('never respawns the old session once a newer run acquired this pane', async () => {
      const { promise: firstAcquire, resolve: resolveFirstAcquire } =
        Promise.withResolvers<OmpRpcChatAcquireResult>()
      acquire.mockReturnValueOnce(firstAcquire)
      acquire.mockResolvedValueOnce({ ok: true })
      const { rerender } = renderHook(
        (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
        { initialProps: BASE_ARGS }
      )
      await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))

      rerender({ ...BASE_ARGS, cwd: '/work/b' })
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
      expect(acquire).toHaveBeenCalledTimes(2)

      resolveFirstAcquire({ ok: false, reason: 'conflict' })
      await act(async () => {})

      expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
      expect(restorePtyBindingsAfterRefusedOmpRpcAcquire).not.toHaveBeenCalled()
      expect(ownershipEntry()?.status).toBe('acquired')
    })

    // Requirement 4 (wave 10 brief): a full acquire -> hand-back -> acquire
    // cycle, modeled on the hook's own real lifecycle — it never unmounts
    // for an ordinary toggle (W6-2), so a genuine identity rebind via
    // rerender is the correct transition, not unmount()/remount. Cycle 2
    // uses the respawned ptyId hand-back would have bound (Decision 1),
    // and its acquire fails — the pane must still end with a live PTY.
    it('restores a live PTY after a second acquire fails following a genuine hand-back cycle', async () => {
      acquire.mockResolvedValueOnce({ ok: true })
      acquire.mockResolvedValueOnce({ ok: false, reason: 'spawn-failed' })
      const { rerender } = renderHook(
        (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
        { initialProps: BASE_ARGS }
      )
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
      expect(ptyKill).toHaveBeenCalledExactlyOnceWith('pty-1', { keepHistory: true })

      // Hand-back respawned pty-2 into the same pane, and the pane's cwd
      // resolved identity moved on accordingly (a genuine rebind).
      rerender({ ...BASE_ARGS, ptyId: 'pty-2', cwd: '/work/b' })

      await waitFor(() => expect(ownershipEntry()?.status).toBe('spawn-failed'))
      expect(ptyKill).toHaveBeenCalledWith('pty-2', { keepHistory: true })
      await waitFor(() =>
        expect(respawnPtyForOmpRpcChatHandbackWithRetry).toHaveBeenCalledWith({
          paneKey: PANE_KEY,
          replacedPtyId: 'pty-2',
          cwd: '/work/b',
          sessionId: 'session-1'
        })
      )
    })
  })
})
