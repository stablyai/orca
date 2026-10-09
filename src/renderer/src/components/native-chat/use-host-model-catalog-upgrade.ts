import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type MutableRefObject
} from 'react'
import {
  readAgentSessionUnavailable,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type { NativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait,
  subscribeHostModelListingWaits
} from './host-model-listing-waits'

/**
 * Upgrades the static seed with the host's stored catalog without waiting on
 * attach. A record-less read (no session yet) resolves the account a launch
 * would pin, so the picker warms during create. An older host answers
 * `forbidden` or `method_not_found` — both mean "no such surface", so the seed
 * stands until the live read lands.
 *
 * When the host says its first listing for the account is running, one more
 * read waits for it — one per chat, joined by every later run and remount.
 * Reports that wait, and why the host's latest answer says no chat can start
 * (kept until the next answer replaces it; a failed read is unknown). The
 * chat's agent starting or stopping reads again; only while a reason is said,
 * the window gaining focus or a turn starting or ending does too: the host
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
  namesDefault: boolean
  /** Where the launch runs: the host names no default its config could replace. */
  worktree?: string
  fence: number | null
  /** The chat's running turn: one running proves its start, which the host re-checks against. */
  turnId?: string | null
  /** The host runs the chat's agent: a reason its start gave ends with it. */
  providerRunning?: boolean
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): { awaitingListing: boolean; unavailable: AgentSessionUnavailable | null } {
  const {
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    namesDefault,
    optionCatalog,
    sessionId,
    target,
    updateOptionState,
    worktree
  } = args
  const waitKey = `${structuredAgentSessionHostKey(target)}\u0000${agent}\u0000${sessionId}`
  const awaitingListing = useSyncExternalStore(subscribeHostModelListingWaits, () =>
    isHostModelListingWaitInFlight(waitKey)
  )
  const [verdict, setVerdict] = useState<{
    key: string
    unavailable: AgentSessionUnavailable | null
  } | null>(null)
  const unavailable = verdict?.key === waitKey ? verdict.unavailable : null
  const [rereads, setRereads] = useState(0)
  const recheck = useCallback(() => setRereads((count) => count + 1), [])
  const said = unavailable !== null
  const turnWhileSaid = said ? (args.turnId ?? null) : null
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
    const params = { agent, sessionId, ...(namesDefault && worktree ? { worktree } : {}) }
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
      if (!catalog) {
        return
      }
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
              namesDefault
            })
          : current
      )
    }
    let leave: (() => void) | null = null
    const waitForListing = (): void => {
      leave = joinHostModelListingWait(waitKey, () => read(true), apply)
    }
    if (isHostModelListingWaitInFlight(waitKey)) {
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
    namesDefault,
    optionCatalog,
    rereads,
    running,
    sessionId,
    turnWhileSaid,
    target,
    updateOptionState,
    waitKey,
    worktree
  ])
  return { awaitingListing, unavailable }
}
