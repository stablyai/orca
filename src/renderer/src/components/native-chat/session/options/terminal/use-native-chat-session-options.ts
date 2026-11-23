import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog'
import {
  takeNativeChatStatusReport,
  type NativeChatStatusReportMemory
} from '../../../../../../../shared/native-chat/input/session-options/native-chat-status-session-options'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { sayNativeChatSessionOptionTranslated } from '../controls/native-chat-session-option-labels-text'
import { createNativeChatPtySessionOptions } from '../../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import {
  dropNativeChatTurnHeldOptionPicks,
  holdNativeChatOptionPicksDuringTurns,
  type NativeChatTurnHeldOptionSurface
} from '../../../../../../../shared/native-chat/input/session-options/native-chat-turn-held-option-surface'
import { toastSessionOptionUpdateFailure } from '../controls/native-chat-session-option-surface-call'
import type { NativeChatSessionOptionDispatchCommand } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-dispatch'
import {
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from '../catalog/native-chat-session-option-enrichment'
import {
  discoverNativeChatCatalogModels,
  resolveNativeChatModelDiscoveryContext
} from '../catalog/native-chat-session-option-discovery'

import { enqueueSessionOptionSettingsWrite } from '../native-chat-session-option-settings-write'

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

const CLIENT_SETTINGS_TARGET = { kind: 'local' } as const

const heldPickScope = (agent: AgentType, ptyId: string): string => `${ptyId}\0${agent}`

// Kept across chat remounts, as on the phone: the same agent session repeating its model is not
// fresh evidence, and reapplying it would revert a newer pick.
const appliedReportByPty: NativeChatStatusReportMemory = new Map()

export function useNativeChatSessionOptions(args: {
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  /** The pane whose agent status reports the session's model and effort, as it does on the phone. */
  paneKey?: string
  isWorking: boolean
}): {
  surface: NativeChatTurnHeldOptionSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const { agent, terminalTabId, targetPtyId, dispatchCommand, onAgentPicker, paneKey, isWorking } =
    args
  const status = useAgentStatus(paneKey)
  const reportedModel = status?.model
  const reportingSessionId = status?.providerSession?.id
  const reportedEffort = status?.providerSession?.effort
  const canSwitchOmpModel = status?.modelSwitchCommand === 'orca-model'
  // Host discovery can resolve a reported id the seed families only matched by family.
  const [discoveredModelsRevision, setDiscoveredModelsRevision] = useState(0)
  const discoveryContext = useMemo(
    () => resolveNativeChatModelDiscoveryContext(terminalTabId),
    [terminalTabId]
  )
  const surface = useMemo(() => {
    // Chat attaches after startup is queued, so a draft picker could no longer change its command.
    if (!targetPtyId) {
      return null
    }
    const scopeKey = targetPtyId ?? terminalTabId
    let held: NativeChatTurnHeldOptionSurface | null = null
    const discoveredModels = discoveryContext
      ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
      : null
    const surface = createNativeChatPtySessionOptions({
      agent,
      scopeKey,
      ...(targetPtyId ? { fallbackScopeKey: terminalTabId } : {}),
      // Version-neutral family seeds keep the picker available while host discovery runs or fails.
      ...(discoveryContext ? { initialModels: discoveredModels ?? undefined } : {}),
      mode: targetPtyId ? 'live' : 'draft',
      modelLabel: sayNativeChatSessionOptionTranslated('model'),
      // A pick replayed at turn end waits for messages queued during the turn rather than cancelling them.
      dispatchCommand: (command, options) =>
        dispatchCommand(command, { ...options, afterQueuedSends: held?.sendingHeldPick() != null }),
      canSwitchOmpModel,
      onAgentPicker,
      persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault }) =>
        // Paired PTY launches still assemble their launch preferences from client settings.
        enqueueSessionOptionSettingsWrite(CLIENT_SETTINGS_TARGET, {
          type: 'apply-picks',
          agent,
          picks: [{ modelId, optionId, value, adoptModelAsLaunchDefault }]
        })
    })
    held = surface
      ? holdNativeChatOptionPicksDuringTurns({
          surface,
          scopeKey: heldPickScope(agent, scopeKey),
          onHeldPickFailed: toastSessionOptionUpdateFailure
        })
      : null
    return held
  }, [
    agent,
    canSwitchOmpModel,
    dispatchCommand,
    discoveryContext,
    onAgentPicker,
    targetPtyId,
    terminalTabId
  ])

  useEffect(() => {
    surface?.setWorking(isWorking)
  }, [isWorking, surface])
  const heldScope = targetPtyId ? heldPickScope(agent, targetPtyId) : null
  useEffect(
    () => () => {
      if (heldScope) {
        dropNativeChatTurnHeldOptionPicks(heldScope)
      }
    },
    [heldScope]
  )

  useEffect(() => {
    if (!surface || !reportedModel || !targetPtyId) {
      return
    }
    const catalog = getAgentSessionOptionCatalog(agent)
    if (!catalog) {
      return
    }
    const models =
      (discoveryContext ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey) : null) ??
      catalog.models
    // A new agent or session in the same terminal reports afresh, even the same model.
    const report = takeNativeChatStatusReport(
      appliedReportByPty,
      targetPtyId,
      agent,
      catalog,
      models,
      {
        model: reportedModel,
        providerSession: { id: reportingSessionId, effort: reportedEffort }
      }
    )
    if (report) {
      surface.reportSessionOptions(report.values, report.forNewModel)
    }
  }, [
    agent,
    discoveredModelsRevision,
    discoveryContext,
    reportedEffort,
    reportedModel,
    reportingSessionId,
    surface,
    targetPtyId
  ])

  useEffect(() => {
    if (!surface || !discoveryContext) {
      return
    }
    const unsubscribe = subscribeNativeChatEnrichedModels(
      agent,
      discoveryContext.hostKey,
      (models) => {
        surface.replaceModels(models)
        setDiscoveredModelsRevision((revision) => revision + 1)
      }
    )
    ensureNativeChatModelEnrichment({
      agent,
      hostKey: discoveryContext.hostKey,
      discover: () =>
        discoverNativeChatCatalogModels(agent, discoveryContext.runtime, discoveryContext.hostKey)
    })
    return unsubscribe
  }, [agent, discoveryContext, surface])

  const snapshot = useSyncExternalStore(
    surface?.subscribe ?? subscribeEmpty,
    surface?.getSnapshot ?? getEmptySnapshot,
    surface?.getSnapshot ?? getEmptySnapshot
  )
  return { surface, snapshot }
}
