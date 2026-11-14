import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  readAgentSessionUnavailable,
  type AgentSessionUnavailable
} from '../../../../../../../shared/agent-session/agent-session-availability'
import type { AgentSessionModelCatalogResult } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import {
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../../../../shared/agent-session/options/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { recordHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import {
  structuredAgentSessionHostKey,
  useStructuredAgentSessionHostCapabilityState
} from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { StructuredAgentSessionOptionRecord } from '../../../../../../../shared/agent-session/options/reconciliation/structured-agent-session-option-state'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait
} from '../../../../../../../shared/host-model-listing-waits'
import { usesModelSpecificAcpEfforts } from '../../../../../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import { AGENT_SESSION_MODEL_EFFORT_DISCOVERY_CAPABILITY } from '../../../../../../../shared/agent-session/structured-agent-session-surface-capabilities'

/** Warm visible chats from the host catalog and share one listing wait per chat. Recheck held unavailability on agent changes, focus and turn edges. */
export function useHostModelCatalogUpgrade(args: {
  agent: AgentType
  selectedModel?: string
  sessionId: string
  target: RuntimeClientTarget
  optionCatalog: AgentSessionOptionCatalog | null
  /** The pane is on screen: a read can start a listing process, so hidden restored tabs must not. */
  enabled: boolean
  /** A launch runs the CLI default when nothing is seeded; a reopened session may not. */
  newLaunch: boolean
  /** Where the launch runs: the host names no default its config could replace. */
  worktree?: string
  /** The chat has a turn or a send, so its answers are its own account's, which a new chat may no longer pin. */
  hasTurn?: boolean
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
  const recordsNewChat = useRef(newLaunch && args.hasTurn !== true)
  const recordingWait = useRef<string | null>(null)
  useEffect(() => {
    receiver.current = args.receiveCatalog
    recordsNewChat.current = newLaunch && args.hasTurn !== true
  }, [args.receiveCatalog, newLaunch, args.hasTurn])
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
  const canDiscoverEfforts =
    useStructuredAgentSessionHostCapabilityState(
      usesModelSpecificAcpEfforts(agent) ? target : null,
      AGENT_SESSION_MODEL_EFFORT_DISCOVERY_CAPABILITY
    ) === 'supported'
  const selectedModel = canDiscoverEfforts ? args.selectedModel : undefined
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
    // A read sent before the chat's first turn or send answers for the account a new chat pins;
    // so does the listing such a read waits on, whichever later run picks that up. Each new read decides alone.
    const readRecords = recordsNewChat.current
    const waitRecords =
      readRecords || (recordingWait.current === waitKey && isHostModelListingWaitInFlight(waitKey))
    const params = {
      agent,
      sessionId,
      ...(selectedModel ? { selectedModel } : {}),
      ...(newLaunch && worktree ? { worktree } : {})
    }
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        waitForListing ? { ...params, waitForListing } : params
      )
    const apply = (
      catalog: AgentSessionModelCatalogResult | null,
      settled = false,
      event: 'demand' | 'progress' = 'demand',
      records = readRecords
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
      if (catalog && records) {
        recordHostModelCatalogSnapshot(target, agent, worktree ?? '', catalog)
      }
      receiver.current(catalog, settled ? 'settled' : event)
    }
    let leave: (() => void) | null = null
    const waitForListing = (): void => {
      recordingWait.current = waitRecords ? waitKey : null
      leave = joinHostModelListingWait(
        waitKey,
        () => read(true),
        (catalog) => {
          apply(
            catalog,
            catalog !== null && !catalog.listingInProgress && catalog.origin !== 'unknown',
            'progress',
            waitRecords
          )
          if (catalog && catalog.origin !== 'unknown' && !catalog.listingInProgress) {
            onListingLanded?.()
          }
        }
      )
    }
    if (isHostModelListingWaitInFlight(waitKey)) {
      // Register a newly chosen target with the host's shared in-flight discovery.
      if (selectedModel) {
        void read(false)
          .then((catalog) => apply(catalog))
          .catch(() => {})
      }
      // A joined listing is still pending, so it cannot settle the seed as installed inventory.
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? settleStructuredAgentSessionBuiltinCatalog(current, true)
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
    selectedModel,
    turnWhileSaid,
    target,
    updateOptionState,
    waitKey,
    worktree
  ])
  return { unavailable, demandModelCatalog: recheck }
}
