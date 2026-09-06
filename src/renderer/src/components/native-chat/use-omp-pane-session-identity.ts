// Decision 2: resolve an OMP pane's session identity from OMP's own on-disk
// state (main-process `ompRpcChat:resolveSessionIdentity`, backed by
// omp-terminal-session-identity.ts) instead of the broken agent-status hook
// chain. This is the value `useOmpRpcChatSession` expects as `sessionFile`
// (despite the name, always a bare session id for omp — see that hook's own
// doc comment); a null return means "nothing to resume yet", which correctly
// keeps that hook's eligibility gate closed rather than guessing.
//
// Standing rule (wave 9, Defect 1): nothing on this path may require or key
// on a live `ptyId`. Decision 1's acquisition kills the pane's PTY on
// success, so gating identity eligibility on `ptyId !== null` — or including
// it in the cache key — makes the feature's own success discard the
// identity it just resolved. `cwd` + agent + local-runtime is the real
// precondition; `ptyId` is an optional accuracy input (it unlocks the
// breadcrumb path, strictly better when available) whose absence degrades
// to the mtime fallback, never to ineligibility.

import { useEffect, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { canOwnOmpRpcSessionLocally, resolveOmpRpcPaneExecutionHost } from './omp-rpc-pane-locality'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'

export type UseOmpPaneSessionIdentityArgs = {
  agent: AgentType | null
  paneKey: string | null
  ptyId: string | null
  cwd: string | null
  runtimeEnvironmentId: string | null
  /** Local Windows project runtime. A resolved WSL runtime must not scan the
   * host's OMP session root. */
  projectRuntime?: ProjectExecutionRuntimeResolution
  /** SSH target owning the pane's worktree (null = this client, undefined =
   *  not yet knowable). The resolver below scans THIS client's `omp` sessions
   *  root, so a pane whose cwd lives on another host must never reach it —
   *  the newest local session for a same-named path is the wrong repository's
   *  (docs/reference/ssh-execution-boundary.md, rule 1). */
  connectionId: string | null | undefined
  isVisible: boolean
}

type ResolvedForIdentity = {
  identityKey: string
  sessionId: string | null
  source: 'breadcrumb' | 'mtime-fallback' | null
}

// Module constant so the ineligible reset below is Object.is-stable and cannot
// loop React on repeat renders.
const UNRESOLVED_IDENTITY: ResolvedForIdentity = { identityKey: '', sessionId: null, source: null }

export function useOmpPaneSessionIdentity(args: UseOmpPaneSessionIdentityArgs): string | null {
  const {
    agent,
    paneKey,
    ptyId,
    cwd,
    runtimeEnvironmentId,
    projectRuntime,
    connectionId,
    isVisible
  } = args
  const executionHost = resolveOmpRpcPaneExecutionHost({
    runtimeEnvironmentId,
    projectRuntime,
    connectionId
  })
  // Stable for the pane's life — a PTY dying, being cleared by acquisition,
  // or being respawned by hand-back must never invalidate an
  // already-resolved identity. `paneKey` (not `ptyId`) is the thing that is
  // actually stable across that churn.
  //
  // Carries every input the eligibility gate reads (XLR-R1-002): keying on
  // `paneKey`+`cwd` alone let a pane whose AGENT or EXECUTION HOST rebound keep
  // the previous binding's id, and because `mergeSticky` never overwrites a
  // non-null id, ownership could kill the new session's PTY and re-acquire the
  // old session before the real resolution landed.
  const identityKey = JSON.stringify([paneKey ?? '', cwd ?? '', agent ?? '', executionHost])
  const [resolved, setResolved] = useState<ResolvedForIdentity>(UNRESOLVED_IDENTITY)
  // Why a latch, not raw `isVisible`, gates the fetch effect: resolution
  // should run once per identity the first time the pane is ever visible,
  // then stay resolved across later visibility toggles — a bare glance at
  // Terminal view and back must never cost a second IPC round trip (mirrors
  // the identical latch in use-omp-rpc-chat-session.ts, F9).
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
  const identityEligible =
    isOmpRpcCatalogAgent(agent) &&
    canOwnOmpRpcSessionLocally(executionHost) &&
    paneKey !== null &&
    cwd !== null
  const eligible =
    identityEligible && visibilityLatch.key === identityKey && visibilityLatch.wasVisible
  // Dropping the cache on the ineligible transition, not just keying on the
  // gate's inputs: a pane that leaves local-OMP and comes back lands on the
  // SAME key tuple, so the key alone cannot tell the two bindings apart.
  //
  // Adjusted during render rather than in an effect because an effect commits
  // one render holding the previous binding's id, and ownership can kill a
  // pane's PTY off this value. Idempotent against the module constant, so it
  // re-renders once and cannot loop.
  if (!identityEligible && resolved !== UNRESOLVED_IDENTITY) {
    setResolved(UNRESOLVED_IDENTITY)
  }

  useEffect(() => {
    if (!eligible) {
      return
    }
    const api = window.api?.ompRpcChat
    if (!api) {
      return
    }
    let cancelled = false
    // Sticky merge (Defect 1 fix requirement): re-resolution — e.g.
    // retried because `ptyId` just appeared and can upgrade a
    // mtime-fallback guess to a breadcrumb hit — may only ever CONFIRM an
    // already-resolved non-null id for this identity, never downgrade it
    // to null and never silently swap it for a different session. A
    // genuine rebind changes `identityKey` instead, which resets this
    // state naturally on the next render.
    const mergeSticky = (
      result: { sessionId: string; source: 'breadcrumb' | 'mtime-fallback' } | null
    ): void => {
      if (cancelled) {
        return
      }
      setResolved((prev) => {
        if (
          prev.identityKey === identityKey &&
          prev.sessionId !== null &&
          !(prev.source === 'mtime-fallback' && result?.source === 'breadcrumb')
        ) {
          return prev
        }
        return {
          identityKey,
          sessionId: result?.sessionId ?? null,
          source: result?.source ?? null
        }
      })
    }
    void api
      .resolveSessionIdentity({ paneKey: paneKey as string, ptyId, cwd: cwd as string })
      .then(mergeSticky)
      .catch(() => mergeSticky(null))
    return () => {
      cancelled = true
    }
  }, [eligible, identityKey, paneKey, ptyId, cwd])

  return resolved.identityKey === identityKey ? resolved.sessionId : null
}
