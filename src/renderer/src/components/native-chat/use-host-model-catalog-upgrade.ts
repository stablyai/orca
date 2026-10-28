import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  readAgentSessionUnavailable,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type { StructuredAgentSessionOptionRecord } from '../../../../shared/structured-agent-session-option-state'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait
} from '../../../../shared/host-model-listing-waits'

/** Warm visible chats from the host catalog; share one listing wait per chat while built-ins stay usable. Recheck held unavailability on agent changes, focus and turn edges. */
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
  /** A new chat’s unpicked reported model may establish the configured default; refresh the next chat’s first-frame cache. */
  reportedUnpickedModel?: boolean
  /** The host runs the chat's agent: a reason its start gave ends with it. */
  providerRunning?: boolean
  /** A listing landed after the chat's options were read, which answered without it. */
  onListingLanded?: () => void
  receiveCatalog: (
    catalog: AgentSessionModelCatalogResult | null,
    event: 'demand' | 'progress' | 'settled'
  ) => void
  activeOptionRecordRef: MutableRefObject<StructuredAgentSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): { unavailable: AgentSessionUnavailable | null; demandModelCatalog: () => void } {
  const {
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    newLaunch,
    onListingLanded,
    optionCatalog,
    sessionId,
    target,
    updateOptionState,
    worktree
  } = args
  const receiver = useRef(args.receiveCatalog)
  useEffect(() => {
    receiver.current = args.receiveCatalog
  }, [args.receiveCatalog])
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
  // Agent start/stop invalidates reasons derived from its previous run.
  const running = args.providerRunning === true
  useEffect(() => {
    if (!said) {
      return
    }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [said, recheck])
  useEffect(() => {
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
    const apply = (
      catalog: AgentSessionModelCatalogResult | null,
      settled = false,
      event: 'demand' | 'progress' = 'demand'
    ): void => {
      if (stale) {
        return
      }
      const next = readAgentSessionUnavailable(catalog?.unavailable)
      setVerdict((current) => {
        const shown = current?.key === waitKey ? current.unavailable : null
        // Retain existing reasons during listing but never newly show stale ones; the shared wait’s reply decides.
        return JSON.stringify(shown) === JSON.stringify(next) ||
          (catalog?.listingInProgress === true && next !== null)
          ? current
          : { key: waitKey, unavailable: next }
      })
      // A new chat's answer is the account's a new chat pins, so the next chat starts from it.
      if (catalog && newLaunch) {
        recordHostModelCatalogSnapshot(target, agent, worktree ?? '', catalog)
      }
      receiver.current(catalog, settled ? 'settled' : event)
    }
    let leave: (() => void) | null = null
    const waitForListing = (): void => {
      leave = joinHostModelListingWait(
        waitKey,
        () => read(true),
        (catalog) => {
          apply(
            catalog,
            catalog !== null && !catalog.listingInProgress && catalog.origin !== 'unknown',
            'progress'
          )
          if (catalog && catalog.origin !== 'unknown' && !catalog.listingInProgress) {
            onListingLanded?.()
          }
        }
      )
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
          // Only hosts reporting an active listing support the wait parameter.
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
    onListingLanded,
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
  return { unavailable, demandModelCatalog: recheck }
}
