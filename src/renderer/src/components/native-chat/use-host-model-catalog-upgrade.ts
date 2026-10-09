import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import {
  readAgentSessionUnavailable,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type { NativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait
} from './host-model-listing-waits'

/**
 * Replaces the quiet placeholder with the host's stored catalog without waiting on
 * attach, and keeps a new chat's answer for the next chat's first frame. A record-less
 * read (no session yet) resolves the account a launch would pin, so the picker warms
 * during create. An older host answers `forbidden` or `method_not_found` — both mean
 * "no such surface" — and the built-in list becomes usable until the live read lands.
 *
 * When the host says its first listing for the account is running, one more
 * read waits for it — one per chat, joined by every later run and remount —
 * so the list updates in place. The picker never waits on it: it stays usable
 * on the built-in list meanwhile, naming no model, and a pick made then stays
 * an intent the session checks.
 * Reports why the host's latest answer says no chat can start (kept until the
 * next answer replaces it; a failed read is unknown). The chat's agent starting
 * or stopping reads again; only while a reason is said, the window gaining
 * focus or a turn starting or ending does too: the host
 * pushes no change, the fix (signing in, installing) happens elsewhere, and a
 * started chat makes the host re-check.
 */
export function useHostModelCatalogUpgrade(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  optionCatalog: AgentSessionOptionCatalog | null
  /** The pane is on screen: a read can start a listing process, so hidden restored tabs must not. */
  enabled: boolean
  /** A launch runs the CLI default when nothing is seeded; a reopened session may not. */
  newLaunch: boolean
  /** Where the launch runs: the host names no default its config could replace. */
  worktree?: string
  fence: number | null
  /** The chat's running turn: one running proves its start, which the host re-checks against. */
  turnId?: string | null
  /** A new chat that named no model has reported what it runs: the host may now name that as the
   *  configured default, so the next chat's first frame reads it again. */
  reportedUnpickedModel?: boolean
  /** The host runs the chat's agent: a reason its start gave ends with it. */
  providerRunning?: boolean
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): { unavailable: AgentSessionUnavailable | null } {
  const {
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    newLaunch,
    optionCatalog,
    sessionId,
    target,
    updateOptionState,
    worktree
  } = args
  const waitKey = `${structuredAgentSessionHostKey(target)}\u0000${agent}\u0000${sessionId}`
  const [verdict, setVerdict] = useState<{
    key: string
    unavailable: AgentSessionUnavailable | null
  } | null>(null)
  const unavailable = verdict?.key === waitKey ? verdict.unavailable : null
  const [rereads, setRereads] = useState(0)
  const recheck = useCallback(() => setRereads((count) => count + 1), [])
  const said = unavailable !== null
  const turnWhileSaid = said ? (args.turnId ?? null) : null
  const reportedUnpickedModel = args.reportedUnpickedModel === true
  // A reason the agent's own start gave ends with that agent: its start or stop reads again,
  // dropping an answer read before it.
  const running = args.providerRunning === true
  useEffect(() => {
    if (!said) {
      return
    }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [said, recheck])
  useEffect(() => {
    // Any agent the host registered: it answers `unknown` for one whose catalog it does not keep.
    if (!enabled || !optionCatalog) {
      return
    }
    let stale = false
    const params = { agent, sessionId, ...(newLaunch && worktree ? { worktree } : {}) }
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        waitForListing ? { ...params, waitForListing } : params
      )
    const apply = (catalog: AgentSessionModelCatalogResult | null): void => {
      const next = readAgentSessionUnavailable(catalog?.unavailable)
      setVerdict((current) => {
        const shown = current?.key === waitKey ? current.unavailable : null
        // A reason the host is still re-checking is kept where shown but never newly shown: the
        // joined read's answer decides, so a fixed sign-in never flashes the old notice.
        return JSON.stringify(shown) === JSON.stringify(next) ||
          (catalog?.listingInProgress === true && next !== null)
          ? current
          : { key: waitKey, unavailable: next }
      })
      // A new chat's answer is the account's a new chat pins, so the next chat starts from it.
      if (catalog && newLaunch) {
        recordHostModelCatalogSnapshot(target, agent, worktree ?? '', catalog)
      }
      updateOptionState((current) =>
        current.record !== activeOptionRecordRef.current
          ? current
          : catalog
            ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
                newLaunch
              })
            : settleStructuredAgentSessionBuiltinCatalog(current)
      )
    }
    let leave: (() => void) | null = null
    const waitForListing = (): void => {
      leave = joinHostModelListingWait(waitKey, () => read(true), apply)
    }
    if (isHostModelListingWaitInFlight(waitKey)) {
      // The host already answered that its listing is running: the built-in list stands meanwhile.
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? settleStructuredAgentSessionBuiltinCatalog(current)
          : current
      )
      waitForListing()
    } else {
      void read(false)
        .then((catalog) => {
          if (stale) {
            return
          }
          apply(catalog)
          // Only a host that reports the listing knows the wait param; an older one refuses it.
          if (catalog.listingInProgress === true) {
            waitForListing()
          }
        })
        .catch(() => {
          if (!stale) {
            apply(null)
          }
        })
    }
    return () => {
      stale = true
      leave?.()
    }
  }, [
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    newLaunch,
    optionCatalog,
    reportedUnpickedModel,
    rereads,
    running,
    sessionId,
    turnWhileSaid,
    target,
    updateOptionState,
    waitKey,
    worktree
  ])
  return { unavailable }
}
