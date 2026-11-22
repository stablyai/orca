import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog'
import { matchNativeChatCatalogModelId } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-state'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { sayNativeChatSessionOptionTranslated } from '../controls/native-chat-session-option-labels-text'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
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

export function useNativeChatSessionOptions(args: {
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  /** The pane whose agent status reports the session's model, as it does on the phone. */
  paneKey?: string
}): {
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const { agent, terminalTabId, targetPtyId, dispatchCommand, onAgentPicker, paneKey } = args
  const status = useAgentStatus(paneKey)
  const reportedModel = status?.model ?? null
  const canSwitchOmpModel = status?.modelSwitchCommand === 'orca-model'
  // Only changed hook models are new evidence; repeated status pings must not undo newer user picks.
  const appliedReportedModelRef = useRef<string | null>(null)
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
    const discoveredModels = discoveryContext
      ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
      : null
    return createNativeChatPtySessionOptions({
      agent,
      scopeKey,
      ...(targetPtyId ? { fallbackScopeKey: terminalTabId } : {}),
      // Version-neutral family seeds keep the picker available while host discovery runs or fails.
      ...(discoveryContext ? { initialModels: discoveredModels ?? undefined } : {}),
      mode: targetPtyId ? 'live' : 'draft',
      modelLabel: sayNativeChatSessionOptionTranslated('model'),
      dispatchCommand,
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
  }, [
    agent,
    canSwitchOmpModel,
    dispatchCommand,
    discoveryContext,
    onAgentPicker,
    targetPtyId,
    terminalTabId
  ])

  // Scope survives surface rebuilds; reapplying an unchanged report would revert the user’s pick.
  useEffect(() => {
    appliedReportedModelRef.current = null
  }, [agent, targetPtyId, terminalTabId])

  useEffect(() => {
    if (!surface || !reportedModel) {
      return
    }
    const catalog = getAgentSessionOptionCatalog(agent)
    if (!catalog) {
      return
    }
    const models =
      (discoveryContext ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey) : null) ??
      catalog.models
    // OMP reports exact selectors, including models absent from cached discovery.
    const matched =
      agent === 'omp'
        ? reportedModel.trim()
        : matchNativeChatCatalogModelId({ ...catalog, models }, reportedModel, {
            allowUnlisted: agent === 'codex'
          })
    if (!matched || appliedReportedModelRef.current === matched) {
      return
    }
    appliedReportedModelRef.current = matched
    surface.reportSessionOptions({ model: matched })
  }, [agent, discoveredModelsRevision, discoveryContext, reportedModel, surface])

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
