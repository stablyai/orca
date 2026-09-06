// The hand-back half of use-omp-rpc-chat-pane-ownership.test.ts, split out
// so neither file exceeds its max-lines budget. Everything here is about
// one question — what this hook asks main for when it stops owning a
// session — while the parent file covers acquisition, eligibility, and the
// turn/command surface.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
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
// recovery.ts) calls these directly for the D1 restore-a-PTY fix (a failed
// acquire after the kill above must never leave the pane with neither a live
// terminal nor an RPC session) — mocked so these tests assert the call rather
// than exercising the real store/layout rebind machinery covered by
// omp-rpc-chat-handback.test.ts. Both imported exports are mocked: a factory
// that omits one makes the recovery path throw on an undefined import.
vi.mock('./omp-rpc-chat-handback', () => ({
  respawnPtyForOmpRpcChatHandbackWithRetry,
  restorePtyBindingsAfterRefusedOmpRpcAcquire
}))

import { OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS } from './omp-rpc-pane-release-obligation'
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
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

// Critical B (cross-lab review, wave 5), still true after relocation: the
// actual settle-wait, release ordering, and respawn live on main and in
// the durable TerminalPane listener (omp-rpc-session-owner.test.ts and
// use-omp-rpc-chat-handback-listener.test.ts) — this hook only expresses
// intent and returns.
describe('hand-back to Terminal view (Critical B)', () => {
  it('keeps a superseding acquisition alive through transient writer-fence conflicts', async () => {
    const firstAcquire = Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire
      .mockReturnValueOnce(firstAcquire.promise)
      .mockResolvedValueOnce({ ok: false, reason: 'conflict' })
      .mockResolvedValueOnce({ ok: false, reason: 'conflict' })
      .mockResolvedValueOnce({ ok: true })
    const hook = renderHook(
      (args: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(args),
      { initialProps: BASE_ARGS }
    )

    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))
    hook.rerender({ ...BASE_ARGS, cwd: '/work/b' })
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
    firstAcquire.resolve({ ok: false, reason: 'conflict' })

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'), { timeout: 2_000 })
    expect(acquire).toHaveBeenCalledTimes(4)
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('requests release with respawn context on real unmount (pane/tab close), and never aborts the turn itself', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(ownershipEntry()?.turnState.status).toBe('working')

    unmount()

    // Why: aborting a live turn is main's call now (handoffToPty's
    // allowAbort opt-in, gated by main owning the settle-wait) — never
    // this hook's. It only expresses intent and returns.
    expect(abort).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
  })

  // Lifecycle recovery (phase `pty-hook-lifecycle`). This used to assert
  // the opposite — a fatal frame released WITHOUT respawn context, on the
  // reasoning that a dead child has no live turn to hand back. That
  // conflates two obligations the wave-10 acquire-failure fix already
  // separated: proving a turn settled protects live work, but giving the
  // pane its terminal back is unconditional. Acquisition killed this
  // pane's PTY, so 'faulted' (which flips `isOwned` false so sends "fall
  // back to PTY") was falling back to a terminal that no longer existed —
  // leaving the pane with neither a session nor a shell, and no way out
  // short of closing the tab.
  it.each(['protocol-fault', 'exit'] as const)(
    'requests the pane its PTY back when a "%s" frame kills the session',
    async (kind) => {
      acquire.mockResolvedValue({ ok: true })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

      emitFatalFrame(kind)

      await waitFor(() =>
        expect(release).toHaveBeenCalledWith({
          paneKey: PANE_KEY,
          respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
        })
      )
      // Main still decides whether a respawn happens (only a release that
      // genuinely settled+exited pushes `ompRpcChat:handback`); this hook
      // never drives the respawn itself, exactly as on the unmount path.
      expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
    }
  )

  // No retry, no re-acquire: the fatal path asks for a terminal back once
  // and stops. A second release would race main's in-flight one — which is
  // why a release main CONFIRMED retires the claim for good, whichever
  // fatal frame kind asked for it.
  it.each(['protocol-fault', 'exit'] as const)(
    'releases exactly once across a "%s" frame and the unmount that follows it',
    async (kind) => {
      acquire.mockResolvedValue({ ok: true })
      const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

      emitFatalFrame(kind)
      await waitFor(() => expect(release).toHaveBeenCalledTimes(1))
      await act(async () => {})

      unmount()

      expect(release).toHaveBeenCalledTimes(1)
      expect(acquire).toHaveBeenCalledTimes(1)
    }
  )

  // Lifecycle recovery, round 2. A `protocol-fault` frame means the
  // TRANSPORT died, which is not evidence the child did — main cannot
  // read its state, cannot prove its exit, and so fails closed with
  // `released: false` and no `ompRpcChat:handback`. The hook used to
  // retire its own claim bookkeeping the instant it fired the request,
  // so that fail-closed release was never retried and the pane stayed
  // stranded (no PTY, claim still held) until app quit. The claim is
  // retired only by a release main actually confirms; anything else
  // stays retryable on unmount, which is the pane's real next chance.
  // XLR-015: the generation check used to return before the cancellation
  // branch, so a run superseded while its acquire was in flight left main an
  // orphaned child AND its session-file exclusion — for a pane with no tracked
  // RPC owner and no terminal, since acquisition had already killed the PTY.
  it('releases an acquire that landed after a rebind handed the pane to a new identity', async () => {
    const { promise, resolve: resolveStaleAcquire } =
      Promise.withResolvers<OmpRpcChatAcquireResult>()
    // The successor loses the pane to the child this stale run still holds, so
    // nobody else can inherit the obligation to retire it.
    acquire.mockReturnValueOnce(promise).mockResolvedValue({ ok: false, reason: 'conflict' })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))

    rerender({ ...BASE_ARGS, cwd: '/work/b' })
    await waitFor(() => expect(ownershipEntry()?.status).toBe('conflict'))
    resolveStaleAcquire({ ok: true })

    // The stale run's own respawn context names the cwd it acquired under, so
    // this release cannot be confused with the live run's.
    await waitFor(() =>
      expect(release).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
      })
    )
    expect(release).toHaveBeenCalledTimes(1)
    // The pane still belongs to the newer run: its status is untouched.
    expect(ownershipEntry()?.status).toBe('conflict')
  })

  // XLR-R3-002 (cross-lab review, round 3): the same late acquire, but the
  // successor has already TAKEN the pane. Release is keyed by paneKey and main
  // holds one registration per pane, so the successor's own acquire is what
  // retired this stale child (the registry's reclaim path) — firing a release
  // here would tear down the session the successor is now publishing.
  it('never releases a late acquire once the successor has taken the pane', async () => {
    const { promise, resolve: resolveStaleAcquire } =
      Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValueOnce(promise).mockResolvedValue({ ok: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))

    rerender({ ...BASE_ARGS, cwd: '/work/b' })
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    await act(async () => {
      resolveStaleAcquire({ ok: true })
    })

    expect(release).not.toHaveBeenCalled()
    expect(ownershipEntry()?.status).toBe('acquired')
  })

  // XLR-R3-002, the other half: the successor never acquired, so this stale run
  // keeps its FULL bounded obligation rather than the single pane-key attempt
  // the old branch fired — a refusal there left the claim held with no PTY.
  it('keeps its bounded retries for a late acquire the successor could not take', async () => {
    const { promise, resolve: resolveStaleAcquire } =
      Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValueOnce(promise).mockResolvedValue({ ok: false, reason: 'conflict' })
    release.mockImplementation(
      () =>
        new Promise<OmpRpcChatReleaseResult>((resolve) => {
          setTimeout(() => resolve({ released: false }), 0)
        })
    )
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))

    rerender({ ...BASE_ARGS, cwd: '/work/b' })
    await waitFor(() => expect(ownershipEntry()?.status).toBe('conflict'))
    resolveStaleAcquire({ ok: true })

    await waitFor(() => expect(release).toHaveBeenCalledTimes(OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS))
  })

  // The other half of that rule: a supersession that kept the SAME identity
  // (StrictMode's double mount) shares one child through the registry's
  // in-flight deduplication, so releasing it would tear down exactly the
  // session the surviving run is publishing.
  it('never releases a same-identity supersession, which shares the surviving run session', async () => {
    const { promise, resolve: resolveFirstAcquire } =
      Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValueOnce(promise).mockResolvedValue({ ok: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))

    // Out of and straight back into eligibility: the resolved identity is
    // sticky (keyed on paneKey + cwd), so the newer run pursues exactly the
    // identity the in-flight one is acquiring.
    rerender({ ...BASE_ARGS, agent: null })
    rerender(BASE_ARGS)
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    resolveFirstAcquire({ ok: true })
    await act(async () => {
      await Promise.resolve()
    })

    expect(release).not.toHaveBeenCalled()
    expect(ownershipEntry()?.status).toBe('acquired')
  })

  it('retries a release main refused on unmount instead of retiring the claim', async () => {
    acquire.mockResolvedValue({ ok: true })
    release.mockResolvedValueOnce({ released: false }).mockResolvedValue({ released: true })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    emitFatalFrame('protocol-fault')
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(ownershipEntry()?.status).toBe('faulted')
    // Let the refusal actually land before unmounting — a release still
    // in flight is deliberately joined, not duplicated.
    await act(async () => {})

    unmount()

    expect(release).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenLastCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
    // Still never a renderer-driven respawn: only main may hand the PTY
    // back, and only once a release genuinely settled and exited.
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
  })

  // XLR-014 (cross-lab review): the same obligation, with no fatal frame in
  // the story at all. A healthy long turn can outrun main's settle deadline, so
  // an ORDINARY cleanup release comes back refused — and the retry used to be
  // reserved for a cleanup that had joined someone else's release, leaving this
  // one with no owner: the completed child, its claim and its session-file
  // exclusion stayed registered until an unrelated remount or app exit.
  it('retries its own refused cleanup release, with no fatal frame involved', async () => {
    acquire.mockResolvedValue({ ok: true })
    release.mockResolvedValueOnce({ released: false }).mockResolvedValue({ released: true })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    unmount()

    await waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(release).toHaveBeenLastCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
  })

  // XLR-039 (cross-lab review): cleanup ran while the acquire was still in
  // flight, so `acquiredThisEffect` was false and cleanup's own bounded retry
  // loop never started. The success that landed afterwards then got ONE
  // unawaited release — and main refuses a release it cannot yet settle (child
  // busy, exit not yet provable), leaving a hidden RPC session, its claim and
  // its session-file exclusion alive until app quit, with no mounted effect and
  // no successor left to ask again.
  it('retries a refused release for an acquire that succeeded after unmount (XLR-039)', async () => {
    const { promise, resolve: resolveAcquire } = Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValue(promise)
    release.mockResolvedValueOnce({ released: false }).mockResolvedValue({ released: true })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))

    unmount()
    expect(release).not.toHaveBeenCalled()

    await act(async () => {
      resolveAcquire({ ok: true })
    })

    await waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(release).toHaveBeenLastCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
  })

  it('keeps retrying a refused cleanup release until main confirms it', async () => {
    acquire.mockResolvedValue({ ok: true })
    release
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValue({ released: true })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    unmount()
    await act(async () => {})
    expect(release).toHaveBeenCalledTimes(3)
  })

  // XLR-026 (cross-lab review): the retry has to end. Main can never classify
  // a protocol-faulted child as exited, so its refusal is permanent, and after
  // a FINAL unmount nothing bumps the generation the retry fences on — the
  // unbounded loop kept starting release plus exit-proof cycles for the app's
  // life, and an instant refusal spun them as fast as IPC answers.
  it('stops retrying a cleanup release once its bounded attempts are spent', async () => {
    acquire.mockResolvedValue({ ok: true })
    // Refused on a macrotask, so a runaway loop shows up as a climbing call
    // count instead of starving the event loop this test runs on.
    release.mockImplementation(
      () =>
        new Promise<OmpRpcChatReleaseResult>((resolve) => {
          setTimeout(() => resolve({ released: false }), 0)
        })
    )
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    unmount()

    await waitFor(() => expect(release).toHaveBeenCalledTimes(OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS))
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(release).toHaveBeenCalledTimes(OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS)
  })

  // XLR-031: the generation fence exists so a stale cleanup never releases a
  // SUCCESSOR's fresh claim — but a bumped generation is not itself a
  // successor. A run that went ineligible (here: the pane's worktree resolves
  // to an SSH host) never calls acquire for this paneKey, so nothing retries
  // the refusal through the registry's reclaim path. Yielding to it orphaned
  // the hidden child and its session-file exclusion until app exit.
  it('keeps retrying a refused cleanup release when no successor inherits the pane', async () => {
    acquire.mockResolvedValue({ ok: true })
    release.mockImplementation(
      () =>
        new Promise<OmpRpcChatReleaseResult>((resolve) => {
          setTimeout(() => resolve({ released: false }), 0)
        })
    )
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    rerender({ ...BASE_ARGS, connectionId: 'ssh:target-1' })

    await waitFor(() => expect(release).toHaveBeenCalledTimes(OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS))
  })

  it('retries a late successful acquire release when an ineligible rebind has no successor', async () => {
    const { promise, resolve: resolveAcquire } = Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValue(promise)
    release.mockResolvedValueOnce({ released: false }).mockResolvedValue({ released: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))

    rerender({ ...BASE_ARGS, connectionId: 'ssh:target-1' })
    await act(async () => {
      resolveAcquire({ ok: true })
    })

    await waitFor(() => expect(release).toHaveBeenCalledTimes(2))
  })

  // R2-001: the same refusal, but the unmount OVERLAPS it instead of
  // following it. Cleanup joins the fatal frame's in-flight release rather
  // than duplicating it — correct, since two concurrent releases would race
  // main's single claim retirement — but the join only transfers the
  // RESULT, not the obligation. The refusal then landed on a torn-down
  // effect, so no second release ever went out: main kept the claim and its
  // session-file exclusion, pushed no hand-back, and the killed PTY was
  // never restored. Cleanup is entitled to one attempt of its OWN, and a
  // join spends someone else's.
  it('retries a refusal that lands after unmount already joined the release in flight', async () => {
    acquire.mockResolvedValue({ ok: true })
    let refuseFatalRelease: () => void = () => {}
    release.mockImplementationOnce(
      () =>
        new Promise<{ released: boolean }>((resolve) => {
          refuseFatalRelease = () => resolve({ released: false })
        })
    )
    release.mockResolvedValue({ released: true })
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    emitFatalFrame('protocol-fault')
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1))

    // Unmount while main is still settling the fatal frame's release.
    unmount()
    expect(release).toHaveBeenCalledTimes(1)

    await act(async () => {
      refuseFatalRelease()
    })

    await waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(release).toHaveBeenLastCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
    expect(respawnPtyForOmpRpcChatHandbackWithRetry).not.toHaveBeenCalled()
  })

  // XLR-R2-001 (cross-lab review, round 2): a successor merely ENGAGING the
  // pane is only an intent to reclaim. Here the stale run is still streaming,
  // so main refuses its release; the successor's own acquire (and its single
  // conflict retry) are refused by that same busy child, and a conflict is
  // deliberately owed no PTY restore. Yielding on engagement alone left the
  // stale claim with nobody holding the retry, so the pane ended with neither
  // a PTY nor RPC ownership. The obligation passes only to a successor that
  // actually acquired.
  it('keeps its release obligation when the successor engages but never acquires', async () => {
    acquire.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'conflict' })
    release.mockImplementation(
      () =>
        new Promise<OmpRpcChatReleaseResult>((resolve) => {
          setTimeout(() => resolve({ released: false }), 0)
        })
    )
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    // Same pane, new identity: the successor engages this paneKey and then
    // loses every acquire to the still-busy child the stale run owns.
    rerender({ ...BASE_ARGS, cwd: '/work/b' })
    await waitFor(() => expect(ownershipEntry()?.status).toBe('conflict'))

    await waitFor(() => expect(release).toHaveBeenCalledTimes(OMP_RPC_CLEANUP_RELEASE_MAX_ATTEMPTS))
  })
})
