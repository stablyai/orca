import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { findRegisteredTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import { useAppStore } from '@/store/index'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog'
import {
  takeNativeChatStatusReport,
  type NativeChatStatusReportMemory
} from '../../../../../../../shared/native-chat/input/session-options/native-chat-status-session-options'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { nextAppliedSessionOptionsAfterPick } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-cache'
import { sayNativeChatSessionOptionTranslated } from '../controls/native-chat-session-option-labels-text'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { NativeChatSessionOptionDispatchCommand } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-dispatch'
import { nativeChatLaunchAgentForLeaf } from '../../../pane/routing/native-chat-leaf-routing'
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
}): {
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const { agent, terminalTabId, targetPtyId, dispatchCommand, onAgentPicker, paneKey } = args
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
    const discoveredModels = discoveryContext
      ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
      : null
    const created = createNativeChatPtySessionOptions({
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
    if (!created) {
      return null
    }
    return {
      ...created,
      setOption: async (id, value) => {
        const result = await created.setOption(id, value)
        const state = useAppStore.getState()
        const applied = state.nativeChatAppliedSessionOptionsByTabId[terminalTabId]
        if (applied?.agent !== agent || !paneKey) {
          return result
        }
        const mounted = findRegisteredTerminalTab(terminalTabId)?.tab
        const manager = mounted?.getManager()
        if (!mounted || !manager) {
          return result
        }
        const pane = resolvePaneKeyForManager(terminalTabId, paneKey, manager)
        const tab = state.tabsByWorktree[mounted.worktreeId]?.find(({ id }) => id === terminalTabId)
        if (
          pane.status === 'resolved' &&
          mounted.getPtyIdForPane(pane.numericPaneId) === targetPtyId &&
          nativeChatLaunchAgentForLeaf({
            launchAgent: tab?.launchAgent,
            launchAgentLeafId: mounted.getTabWideAgentHintLeafId(),
            leafId: pane.leafId,
            leafIds: manager.getPanes().map(({ leafId }) => leafId)
          }) === agent
        ) {
          state.setNativeChatAppliedSessionOptions(terminalTabId, {
            agent: applied.agent,
            values: nextAppliedSessionOptionsAfterPick(applied.values, id, value)
          })
        }
        return result
      }
    }
  }, [
    agent,
    canSwitchOmpModel,
    dispatchCommand,
    discoveryContext,
    onAgentPicker,
    paneKey,
    targetPtyId,
    terminalTabId
  ])

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
