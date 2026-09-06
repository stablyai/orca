// Anchors RPC ownership (Decision 1, wave 4/5's kill-and-resume acquisition)
// to the pane's life, not a Chat-view mount. Mounted once in TerminalPane —
// which the codebase already keeps deliberately mounted through the
// Chat-view unmount for exactly this reason (wave 5 put the hand-back
// listener there, use-omp-rpc-chat-handback-listener.ts) — this hook never
// unmounts on an ordinary Terminal<->Chat toggle, only on pane/tab close,
// an identity rebind, or app quit. It publishes status/turnState into the
// ompRpcChatPaneOwnership store slice (paneKey-scoped, mirroring
// agentStatusByPaneKey) instead of returning React state: NativeChatView is
// a pure remountable subscriber to that slice and owns none of this
// lifecycle (use-native-chat-omp-rpc-integration.ts).
// Composes use-omp-pane-session-identity.ts (Decision 2) internally, so the
// session-id resolution that acquisition depends on lives on the same lifecycle.

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { OmpRpcChatAcquireResult } from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { hydrateOmpRpcChatHistory } from './omp-rpc-history-hydration'
import { canOwnOmpRpcSessionLocally, resolveOmpRpcPaneExecutionHost } from './omp-rpc-pane-locality'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'
import { useOmpPaneSessionIdentity } from './use-omp-pane-session-identity'
import { useOmpRpcChatAdoptableIdentity } from './use-omp-rpc-chat-pane-adoption'
import {
  recoverPtyAfterAbandonedOmpRpcAcquire,
  recoverPtyAfterRefusedOmpRpcAcquire
} from './omp-rpc-acquire-failure-pty-recovery'
import {
  beginOmpRpcPanePursuit,
  inheritingOmpRpcPanePursuit,
  releaseOmpRpcPaneClaimOnCleanup,
  type OmpRpcPanePursuit
} from './omp-rpc-pane-release-obligation'
import { retryOmpRpcAcquireAfterConflict } from './omp-rpc-conflict-acquire-retry'

export type UseOmpRpcChatPaneOwnershipArgs = {
  agent: AgentType | null
  /** Composite `${tabId}:${leafId}` key of the pane currently designated as
   *  the tab's chat leaf; null when no leaf has ever been chosen. */
  paneKey: string | null
  ptyId: string | null
  cwd: string | null
  /** True only while the Chat view is actually showing this leaf and the
   *  tab is rendered — the trigger for the FIRST acquisition. Later drops
   *  to false on an ordinary Terminal<->Chat toggle without releasing
   *  (F9's latch below), which is the entire point of anchoring this hook
   *  here instead of inside the (un)mountable chat surface. */
  isVisible: boolean
  /** Non-null routes the pane to a remote runtime host (Model B); RPC
   *  ownership spawns `omp` on THIS client, so a runtime-owned pane never
   *  acquires. */
  runtimeEnvironmentId: string | null
  /** Local Windows project runtime. WSL panes are never host-RPC-ownable. */
  projectRuntime?: ProjectExecutionRuntimeResolution
  /** SSH target owning the pane's worktree: null = this client, a target id =
   *  a remote host, undefined = not yet knowable. Only `null` is local — see
   *  `resolveOmpRpcPaneExecutionHost`. */
  connectionId: string | null | undefined
}

export { isOmpRpcChatSessionEligible } from './omp-rpc-pane-eligibility'

let subscriptionCounter = 0
function nextOmpRpcChatSubscriptionId(): string {
  return `omp-rpc-chat-${++subscriptionCounter}-${Date.now()}`
}

/** Lives outside the effect: react-doctor's effect-needs-cleanup
 *  false-positives on `subscribe` calls inside an effect body (see the
 *  identical note in useDashboardPopoutBridge.ts); the effect's own returned
 *  cleanup below still owns and calls the unsubscribe this returns.
 *  `onFatalFrame` fires for `exit`/`protocol-fault` (F3): the reducer itself
 *  stays a pure state machine, but the hook is the D1 fallback boundary — a
 *  dead transport must flip status away from 'acquired' so sends route back
 *  to PTY, and must ask for that PTY back, since acquisition killed it. */
function subscribeOmpRpcChatFrames(
  api: NonNullable<typeof window.api.ompRpcChat>,
  paneKey: string,
  dispatchTurnAction: (paneKey: string, event: OmpRpcClientEvent) => void,
  onFatalFrame: () => void
): () => void {
  const subscriptionId = nextOmpRpcChatSubscriptionId()
  return api.subscribe({ paneKey, subscriptionId }, (event) => {
    dispatchTurnAction(paneKey, event)
    if (event.kind === 'exit' || event.kind === 'protocol-fault') {
      onFatalFrame()
    }
  })
}

/** Decision 1's acquire trigger: kill the pane's live PTY (scrollback kept
 *  for the eventual hand-back) so the registry's existing exit-proof gate —
 *  unchanged — sees it as exited and proceeds. Best-effort: an already-dead
 *  PTY or a transient kill failure must not block acquisition; the registry's
 *  liveness check is the actual proof gate and fails closed on its own.
 *
 *  Why (Critical A, cross-lab review): every OTHER intentional-kill site in
 *  this codebase (codex-detached-pane-restart.ts, the hibernation/sleep
 *  flows) suppresses the pty:exit before killing a PTY it means to replace,
 *  so pty-exit-hibernate.ts's onExit lands on its suppressed branch instead
 *  of the "process died" teardown, which — for the ordinary single-pane tab
 *  — closes the whole tab (`panes.length <= 1` -> `onPtyExitRef.current` ->
 *  `closeTerminalTab`). This function used to skip suppression entirely.
 *  The suppression flag is left ARMED here, not self-consumed: onExit
 *  itself must be the one to consume it once the real exit round-trips
 *  back — self-consuming now would leave that later, real exit unsuppressed
 *  and fall through to the same tab-close bug. `clearTabPtyId` and
 *  `clearTerminalLayoutPanePtyId` are also called proactively, putting the
 *  tab AND the layout's leaf binding into a well-defined "RPC-owned, no
 *  PTY" state immediately rather than waiting on the kill's async round
 *  trip — onExit's own cleanup would eventually clear the tab record too
 *  (gated only on `preserveRendererBinding`, which this never sets), but it
 *  skips the layout leaf clear entirely for a suppressed exit (wave 10:
 *  every other suppress-then-kill caller immediately rebinds the leaf
 *  itself, so that skip was never reachable there before this feature) —
 *  without the explicit call here, a pane whose eventual restore also
 *  fails is left advertising a leaf pty id whose process is gone.
 *
 *  Returns whether the stop was actually accepted (XLR-001, cross-lab
 *  review). A kill that THREW is no evidence the child is gone — the SSH
 *  execution boundary's rule 1 — so it must not entitle the failure path
 *  below to respawn a second `omp --resume` against the same session. */
async function killPtyBeforeOmpRpcAcquire(paneKey: string, ptyId: string | null): Promise<boolean> {
  const ptyApi = window.api?.pty
  // An absent kill surface is the same evidence as a thrown one: none. A pane
  // with no PTY at all takes the same answer (an adopting renderer,
  // XLR-R6-004) — and both are checked BEFORE the pre-kill mutations below,
  // which have no pty id to name and nothing to undo.
  if (!ptyApi?.kill || ptyId === null) {
    return false
  }
  const store = useAppStore.getState()
  store.suppressPtyExit(ptyId)
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    store.clearTabPtyId(parsed.tabId, ptyId)
    store.clearTerminalLayoutPanePtyId(parsed.tabId, parsed.leafId, ptyId)
  }
  try {
    await ptyApi.kill(ptyId, { keepHistory: true })
  } catch {
    return false
  }
  return true
}

/** Acquires (and holds, for the pane's life) an RPC-owned OMP chat session,
 *  publishing status/turnState into the ompRpcChatOwnershipByPaneKey store
 *  slice. Returns void — every consumer reads the slice, never this hook's
 *  own return value, so remounting the chat surface never re-triggers
 *  acquisition or loses in-flight state. */
export function useOmpRpcChatPaneOwnership(args: UseOmpRpcChatPaneOwnershipArgs): void {
  const {
    agent,
    paneKey,
    ptyId,
    cwd,
    isVisible,
    runtimeEnvironmentId,
    projectRuntime,
    connectionId
  } = args
  const executionHost = resolveOmpRpcPaneExecutionHost({
    runtimeEnvironmentId,
    projectRuntime,
    connectionId
  })
  const isLocallyOwnable = canOwnOmpRpcSessionLocally(executionHost)
  // Decision 2: resolved from OMP's own on-disk state, on the same
  // pane-anchored lifecycle as acquisition itself now — see that hook's own
  // doc comment for why a null return correctly keeps acquisition closed.
  const resolvedSessionFile = useOmpPaneSessionIdentity({
    agent,
    paneKey,
    ptyId,
    cwd,
    runtimeEnvironmentId,
    projectRuntime,
    connectionId,
    isVisible
  })
  const setOmpRpcChatPaneStatus = useAppStore((s) => s.setOmpRpcChatPaneStatus)
  const setOmpRpcChatPaneResolvedSessionId = useAppStore(
    (s) => s.setOmpRpcChatPaneResolvedSessionId
  )
  const dispatchOmpRpcChatTurnAction = useAppStore((s) => s.dispatchOmpRpcChatTurnAction)
  const clearOmpRpcChatPaneOwnership = useAppStore((s) => s.clearOmpRpcChatPaneOwnership)
  // Why (F9): visibility gates the FIRST acquisition (don't spawn an RPC
  // child for a pane whose Chat view has never been opened) but must never
  // trigger release on its own afterward — toggling Chat -> Terminal and
  // back must not abort a live turn. The latch remembers "has this identity
  // ever been visible" and only resets on a genuine identity rebind.
  //
  // Standing rule (wave 9, Defect 1): this key — and everything derived
  // from it (the latch, `identityEligible` below) — deliberately excludes
  // `ptyId`. Decision 1's acquisition kills the pane's live PTY on success,
  // so keying identity/eligibility on it makes the hook's own success
  // invalidate the state it just published, tearing ownership back down.
  // `ptyId` is consumed only where it is actually needed: as an input to
  // the acquire call itself, captured once per genuine identity, below.
  const adoptedSessionFile = useOmpRpcChatAdoptableIdentity(paneKey, ptyId !== null)
  const sessionFile = adoptedSessionFile ?? resolvedSessionFile
  const identityKey = `${paneKey ?? ''}:${cwd ?? ''}:${sessionFile ?? ''}`
  const [visibilityLatch, setVisibilityLatch] = useState<{ key: string; wasVisible: boolean }>({
    key: identityKey,
    wasVisible: false
  })
  useEffect(() => {
    setVisibilityLatch((previous) => {
      if (previous.key !== identityKey) {
        return { key: identityKey, wasVisible: isVisible }
      }
      if (isVisible && !previous.wasVisible) {
        return { ...previous, wasVisible: true }
      }
      return previous
    })
  }, [identityKey, isVisible])
  // Why (F5): every effect run gets a new generation; a callback whose
  // generation the ref has since moved past was superseded by a later
  // effect run (StrictMode's double mount, or a rapid rebind) and must do
  // nothing — the newer run alone owns the acquire/release lifecycle for
  // this identity, so both callbacks racing to act on the same promise can
  // never both mutate state or both release.
  const generationRef = useRef(0)
  // Once the acquire effect below has genuinely started pursuing an
  // identity, a live `ptyId` is no longer required to stay eligible for
  // it — read during render, written only by that effect, so a `ptyId`
  // that goes null (acquisition's own kill) never regresses an identity
  // already being pursued. Reset to null the moment an identity stops
  // being pursued, so a later genuine rebind again requires a real
  // `ptyId` to start.
  const engagedIdentityRef = useRef<string | null>(null)
  const pursuitRef = useRef<OmpRpcPanePursuit | null>(null)
  const hasStartedOmpRpcAcquireRef = useRef(false)

  // A pane main still owns is engageable with no PTY of its own (XLR-R6-004):
  // that is exactly the restarted-renderer case, where the null binding was
  // written by the acquisition being adopted.
  const identityEligible =
    paneKey !== null &&
    isOmpRpcCatalogAgent(agent) &&
    isLocallyOwnable &&
    cwd !== null &&
    sessionFile !== null &&
    (ptyId !== null || engagedIdentityRef.current === identityKey || adoptedSessionFile !== null)
  const eligible =
    identityEligible && visibilityLatch.key === identityKey && visibilityLatch.wasVisible

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    if (paneKey === null) {
      return
    }
    // Publish identity in the same effect generation that owns status. A
    // separate effect can race this effect's prior cleanup and recreate an
    // acquired row without the transcript identity.
    // Every identity rebind (including going eligible -> ineligible) starts
    // the next turn's overlay from empty, so a previous pane's content can
    // never bleed into this one.
    setOmpRpcChatPaneStatus(paneKey, 'idle')
    dispatchOmpRpcChatTurnAction(paneKey, { type: 'reset' })
    if (sessionFile !== null) {
      setOmpRpcChatPaneResolvedSessionId(paneKey, sessionFile)
    }
    if (!eligible) {
      engagedIdentityRef.current = null
      pursuitRef.current = null
      return () => {
        clearOmpRpcChatPaneOwnership(paneKey)
      }
    }
    const api = window.api?.ompRpcChat
    if (!api) {
      setOmpRpcChatPaneStatus(paneKey, 'spawn-failed')
      return () => {
        clearOmpRpcChatPaneOwnership(paneKey)
      }
    }
    // `eligible` only ever becomes true here with a real `ptyId` (a
    // first-time engagement) or with `engagedIdentityRef` already matching
    // (this identity's acquire/hold lifecycle already captured a real
    // `ptyId` on the effect run that engaged it, and — because none of this
    // effect's own dependencies include raw `ptyId` — that earlier run is
    // still the one live; this run only ever fires fresh for a genuinely
    // new identity, which always starts with a real `ptyId`).
    const retriesAfterPreviousAcquire = hasStartedOmpRpcAcquireRef.current
    engagedIdentityRef.current = identityKey
    const settlePursuit = beginOmpRpcPanePursuit(pursuitRef, paneKey, generation)
    let cancelled = false,
      unsubscribe: (() => void) | null = null
    let acquiredThisEffect = false,
      releaseInFlight: Promise<boolean> | null = null
    setOmpRpcChatPaneStatus(paneKey, 'preparing')

    // Critical B: expresses hand-back intent to main alongside every
    // release this effect fires — whether from cleanup (identity rebind,
    // pane/tab close, app quit) or from the cancelled-before-acquired race
    // below. Main decides whether a respawn actually happens (only once
    // release genuinely settles+exits, via the `ompRpcChat:handback` push
    // event); this hook never waits for or drives the respawn itself — see
    // use-omp-rpc-chat-handback-listener.ts, which TerminalPane subscribes
    // to for exactly that reason.
    const respawnContext = {
      // Empty for an adopting renderer with no PTY to replace: the hand-back
      // still owes this pane a terminal, it just replaces nothing (XLR-R6-004).
      replacedPtyId: ptyId ?? '',
      cwd: cwd as string,
      sessionId: sessionFile as string
    }

    // Single release channel for this effect generation. Two rules, both
    // learned the hard way: a release already in flight is JOINED, never
    // duplicated (a fatal frame and the unmount that follows it must not
    // race main's one release), and the claim is retired only by a release
    // main actually confirms — a fail-closed `released: false` leaves it
    // outstanding so cleanup gets a real second chance.
    const requestRelease = (): Promise<boolean> => {
      if (releaseInFlight) {
        return releaseInFlight
      }
      const pending = api
        .release({ paneKey, respawn: respawnContext })
        .then((result) => result.released)
        .catch(() => false)
        .then((released) => {
          releaseInFlight = null
          if (released) {
            acquiredThisEffect = false
          }
          return released
        })
      releaseInFlight = pending
      return pending
    }

    // The second chance above is cleanup's, and it is owed whichever way the
    // first attempt was spent — joining a fatal frame's in-flight release
    // spends that frame's attempt, and an own attempt main refuses is no
    // better off (XLR-014): either way the effect is torn down and nothing
    // else is left holding the retry, so main keeps the claim, its
    // session-file exclusion, and the PTY it never handed back. Fenced on the
    // generation: a rebind hands this paneKey to a newer run, whose fresh
    // claim this stale cleanup must never release — that case is retried by
    // the newer run's own acquire instead (omp-rpc-chat-session-registry.ts).
    //
    // But a bumped generation alone is NOT that successor (XLR-031), and
    // neither is one that merely engaged the pane (XLR-R2-001) — who really
    // inherits, and why the wait on their acquire outcome is what keeps this
    // safe, lives in omp-rpc-pane-release-obligation.ts.
    const releaseOnCleanup = (): Promise<void> =>
      releaseOmpRpcPaneClaimOnCleanup(requestRelease, () =>
        inheritingOmpRpcPanePursuit(pursuitRef.current, paneKey, generation, generationRef.current)
      )

    const acquireOnce = (): Promise<OmpRpcChatAcquireResult> => {
      const agentCommand = useAppStore.getState().settings?.agentCmdOverrides?.omp?.trim()
      return (
        api
          .acquire({
            paneKey,
            ptyId,
            cwd: cwd as string,
            sessionFile: sessionFile as string,
            ...(agentCommand ? { agentCommand } : {})
          })
          // Why (F7): a rejection crossing the IPC boundary (e.g. the main
          // handler's executable resolution throwing) must degrade to a
          // fail-closed result, not an unhandled rejection that leaves
          // status pinned at 'pending' forever.
          .catch((): OmpRpcChatAcquireResult => ({ ok: false, reason: 'spawn-failed' }))
      )
    }

    const onFatalFrame = (): void => {
      if (generation !== generationRef.current) {
        return
      }
      setOmpRpcChatPaneStatus(paneKey, 'faulted')
      unsubscribe?.()
      unsubscribe = null
      // Why respawn context (wave 12): this used to be a bare release, on
      // the reasoning that a dead child has no live turn to hand back. But
      // hand-back and settle-proof are different obligations — the same
      // separation wave 10 root-caused on the acquire-failure path. The
      // status above flips `isOwned` false precisely so sends "fall back to
      // PTY", and acquisition killed this pane's PTY, so without asking for
      // it back the fallback has no target: the pane is left with neither a
      // session nor a shell.
      //
      // What this CANNOT do, and deliberately does not pretend to: an
      // `exit` frame is proof the child is gone, so main's release settles,
      // exits, and pushes the hand-back. A `protocol-fault` frame is proof
      // only that the TRANSPORT died — main can neither read the child's
      // state nor prove its exit, so it fails closed (`released: false`,
      // no hand-back) and the PTY stays gone, because respawning one
      // against a still-live child would put two writers on the session
      // file. Recovering that case needs an out-of-band liveness signal the
      // wire protocol does not carry (docs/omp-rpc-dependency-followups.md).
      // The honest remainder is to keep the claim RETRYABLE: the request is
      // fired once, and only a release main confirms retires it.
      void requestRelease()
    }

    void (async () => {
      // Decision 1: the PTY is very likely still live (that is the normal
      // case now — chat-view activation is the trigger, not a PTY that
      // happened to exit on its own). Kill it first so the unchanged
      // exit-proof gate inside acquireOnce() sees a genuinely exited PTY.
      const killed = !cancelled && (await killPtyBeforeOmpRpcAcquire(paneKey, ptyId))
      // XLR-015: the kill round-trips through main, and the pane can be
      // cancelled inside that window — this effect's cleanup has already run by
      // then, so an acquire dispatched now would spawn an RPC child nobody is
      // left to release. Settle the PTY the kill already took instead; the
      // decision is the same closed one a refusal earns.
      if (cancelled) {
        await recoverPtyAfterAbandonedOmpRpcAcquire({ paneKey, respawnContext, killed })
        return
      }
      // Synchronous renderer-side fence: from this assignment until the IPC
      // result settles, main may already have started the successor RPC child.
      // Hand-back recovery treats this state as ownership-active (XLR-051).
      setOmpRpcChatPaneStatus(paneKey, 'pending')
      hasStartedOmpRpcAcquireRef.current = true
      let result = await acquireOnce()
      result = await retryOmpRpcAcquireAfterConflict({
        initialResult: result,
        retriesAfterPreviousAcquire,
        acquire: acquireOnce,
        shouldContinue: () => !cancelled && generation === generationRef.current,
        onExtendedRetry: () => {
          settlePursuit(false)
          setOmpRpcChatPaneStatus(paneKey, 'conflict')
        }
      })
      // D1 fix (wave 7, root-caused wave 10): a failed acquire after the
      // kill above must never leave the pane with neither a live terminal
      // nor an RPC session — the exact "broken pane" outcome the wave-4
      // review warned about. `api.release({respawn})` would no-op here:
      // the registry never stored a session for this paneKey (acquire
      // never reached `acquired`), so `released` comes back false and the
      // `ompRpcChat:handback` push this pane's listener depends on never
      // fires (release() only pushes it once a real release settles+exits
      // — see omp-rpc-chat.ts). Call the same respawn the listener uses
      // directly instead, retried once (respawnPtyWithRetry) since the
      // failure that just killed the RPC acquire and the one about to
      // attempt this respawn share a plausible common cause (both launch
      // the same `omp` binary).
      //
      // Deliberately BEFORE the generation-supersede check below (wave 10
      // root cause): that check exists to stop a stale run from publishing
      // status over a newer run's, but restoring a PTY is a different
      // obligation — this run, and only this run, killed the exact PTY in
      // `respawnContext`, so giving it back can never race a *different*
      // generation's own kill/restore of a *different* ptyId. Wave 7's
      // restore sat after this check instead, so any run superseded while
      // its acquire was still in flight (a later effect run starting for
      // the same identity before this one's `acquireOnce()` settled) never
      // reached the respawn call at all — silently leaving the pane with
      // neither a live PTY nor RPC ownership on exactly a re-acquire's
      // race. Awaiting it here (instead of the old fire-and-forget `void`)
      // is what makes the retry possible and means a failure result is no
      // longer discarded unread.
      //
      // WHICH recovery a refusal actually earns — respawn, undo the pre-kill
      // mutations, or (once a newer run holds the pane) neither — is one
      // closed decision, and it lives in
      // omp-rpc-acquire-failure-pty-recovery.ts.
      if (!result.ok && !cancelled && generation === generationRef.current) {
        // Disarm this attempt's own PTY recovery before it consults the shared
        // ownership row; only a successor's preparing/pending state may block it.
        setOmpRpcChatPaneStatus(paneKey, result.reason)
      }
      if (!result.ok) {
        await recoverPtyAfterRefusedOmpRpcAcquire({ paneKey, respawnContext, killed, result })
      }
      if (generation !== generationRef.current) {
        // Superseded by a later effect run, which owns this identity's
        // lifecycle now — never publish status or release out from under
        // it. The recovery above already ran regardless, so this pane still
        // gets its PTY back unless that later run has itself acquired.
        //
        // A SUCCESSFUL acquire still has to be retired here (XLR-015): this
        // used to return unconditionally, so a run superseded while its
        // acquire was in flight left main an orphaned child plus its
        // session-file exclusion, for a pane with no tracked RPC owner and no
        // terminal. Released only when the surviving run is pursuing a
        // DIFFERENT identity (including none at all — an ineligible pane
        // clears the ref): on the same identity the registry deduplicates
        // both runs onto one child, which is the session the newer run is
        // about to publish, and releasing it would tear down exactly what
        // StrictMode's double mount is supposed to keep.
        //
        // Through `releaseOnCleanup`, never a bare pane-key release (XLR-R3-002,
        // cross-lab review round 3): a successor merely PURSUING this pane is
        // not yet its owner. Releasing by paneKey the moment one exists tore
        // down the session that successor had already acquired, and when it had
        // instead failed, the single attempt left a stale claim with no PTY
        // restored and nobody holding the retry. The shared obligation waits on
        // the pursuit's outcome and keeps its bounded attempts otherwise.
        if (result.ok && engagedIdentityRef.current !== identityKey) {
          void releaseOnCleanup()
        }
        return
      }
      if (cancelled) {
        // The pane unmounted, went invisible-before-ever-visible, or
        // rebound identity while the acquisition was in flight — never
        // leave a just-acquired child holding the session hostage, and
        // never strand the pane without a PTY: its live one was already
        // killed above, so ask for the same hand-back a normal unmount
        // would.
        //
        // Through `releaseOnCleanup`, not a bare attempt (XLR-039): cleanup
        // ran while `acquiredThisEffect` was still false, so its own bounded
        // retry loop never started and this is the whole obligation. A single
        // refusal (child still busy, exit not yet provable) would otherwise
        // strand a hidden session and its claim with no successor to retry —
        // main's release is exactly the retryable one cleanup gets attempts for.
        if (result.ok) {
          void releaseOnCleanup()
        }
        return
      }
      if (!result.ok) {
        return
      }
      acquiredThisEffect = true
      setOmpRpcChatPaneStatus(paneKey, 'acquired')
      unsubscribe = subscribeOmpRpcChatFrames(
        api,
        paneKey,
        (key, event) => dispatchOmpRpcChatTurnAction(key, { type: 'frame', event }),
        onFatalFrame
      )
      // Why: the pane's transcript reader watches OMP's session file, which
      // lags whatever the owning child holds in memory — most visibly right
      // after a reconnect. Drain the session's own history once per acquired
      // generation and let the renderer rank the two (the transcript still
      // wins every turn it covers). Fenced by that generation so a snapshot
      // from a superseded session can never land on its replacement, and
      // fire-and-forget: a pane that cannot hydrate keeps today's behavior.
      const acquiredGeneration =
        useAppStore.getState().ompRpcChatOwnershipByPaneKey[paneKey]?.generation
      void hydrateOmpRpcChatHistory({
        api,
        paneKey,
        isCancelled: () => cancelled || generation !== generationRef.current,
        onHydrated: (snapshot) =>
          dispatchOmpRpcChatTurnAction(
            paneKey,
            // The identity drained under (XLR-025): without it, the first
            // identity the session publishes cannot be told apart from a switch.
            { type: 'history-hydrated', ...snapshot, sessionId: sessionFile },
            acquiredGeneration
          )
      })
    })().finally(() => settlePursuit(acquiredThisEffect))

    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
      if (acquiredThisEffect) {
        void releaseOnCleanup()
      }
      clearOmpRpcChatPaneOwnership(paneKey)
    }
    // Why: `ptyId` and `identityKey` are deliberately excluded (wave 9,
    // Defect 1's standing rule) — `identityKey` is a derived display of
    // `paneKey`/`cwd`/`sessionFile`, already listed below, and `ptyId`
    // churning to null from this effect's own kill must never re-trigger
    // it; `ptyId`'s only use is a closure read of whatever value was live
    // the one time this effect actually starts a fresh identity.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    eligible,
    paneKey,
    cwd,
    sessionFile,
    setOmpRpcChatPaneStatus,
    setOmpRpcChatPaneResolvedSessionId,
    dispatchOmpRpcChatTurnAction,
    clearOmpRpcChatPaneOwnership
  ])
}
