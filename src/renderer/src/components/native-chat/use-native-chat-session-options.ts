import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import { matchNativeChatCatalogModelId } from '../../../../shared/native-chat/input/native-chat-session-option-state'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { useAppStore } from '../../store'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from './native-chat-pty-session-options'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-command-dispatch'
import {
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'
import {
  discoverNativeChatCatalogModels,
  resolveNativeChatModelDiscoveryContext
} from './native-chat-session-option-discovery'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'

import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

const CLIENT_SETTINGS_TARGET = { kind: 'local' } as const

/** Retire authoritative missing model defaults too: launch sites without a picker still turn persisted IDs into -m arguments. */
export async function retirePersistedModelMissingFromDiscovery(
  agent: AgentType,
  models: readonly CatalogModel[]
): Promise<void> {
  if (!getAgentSessionOptionCatalog(agent)?.discoveredModelsAreAuthoritative) {
    return
  }
  // An empty list means the probe failed, not that the account has no models.
  if (models.length === 0) {
    return
  }
  await enqueueSessionOptionSettingsWrite(CLIENT_SETTINGS_TARGET, {
    type: 'clear-model-if-missing',
    agent,
    availableModelIds: models.map((model) => model.id)
  })
}

export function useNativeChatSessionOptions(args: {
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  readTerminalScreen?: () => string | null
  /** OMP model evidence comes from its hook; Claude uses its terminal frame. */
  paneKey?: string
}): {
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const {
    agent,
    terminalTabId,
    targetPtyId,
    dispatchCommand,
    onAgentPicker,
    readTerminalScreen,
    paneKey
  } = args
  const reportedModel = useAppStore((state) =>
    paneKey ? (state.agentStatusByPaneKey[paneKey]?.model ?? null) : null
  )
  const canSwitchOmpModel = useAppStore((state) =>
    paneKey ? state.agentStatusByPaneKey[paneKey]?.modelSwitchCommand === 'orca-model' : false
  )
  // Only changed hook models are new evidence; repeated status pings must not undo newer user picks.
  const appliedReportedModelRef = useRef<string | null>(null)
  // Cache parsed screen text so late discovery can resolve real host model IDs.
  const reportedScreenRef = useRef<string | null>(null)
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
    const reportedValues =
      agent === 'claude'
        ? readClaudeSessionOptionsFromTerminalScreen(
            readTerminalScreen?.(),
            discoveredModels ?? undefined
          )
        : null
    return createNativeChatPtySessionOptions({
      agent,
      scopeKey,
      ...(targetPtyId ? { fallbackScopeKey: terminalTabId } : {}),
      // Version-neutral family seeds keep the picker available while host discovery runs or fails.
      ...(discoveryContext ? { initialModels: discoveredModels ?? undefined } : {}),
      mode: targetPtyId ? 'live' : 'draft',
      reportedValues,
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
    readTerminalScreen,
    targetPtyId,
    terminalTabId
  ])

  useEffect(() => {
    if (!surface || agent !== 'claude') {
      return
    }
    let cancelled = false
    reportedScreenRef.current = null
    const reportCurrentValues = async (): Promise<void> => {
      let authoritativeScreen: string | null = null
      if (targetPtyId && window.api?.pty?.getMainBufferSnapshot) {
        try {
          const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
            scrollbackRows: 0
          })
          // Main-buffer snapshots are stale during alternate-screen TUIs; use mounted xterm then.
          authoritativeScreen = snapshot?.alternateScreen ? null : (snapshot?.data ?? null)
        } catch {
          // The mounted renderer buffer remains a transport-neutral fallback.
        }
      }
      const models = discoveryContext
        ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
        : null
      for (const screen of [authoritativeScreen, readTerminalScreen?.() ?? null]) {
        const reportedValues = readClaudeSessionOptionsFromTerminalScreen(
          screen,
          models ?? undefined
        )
        if (!reportedValues) {
          continue
        }
        // Retain parsed screen text for late discovery after the model frame scrolls away.
        if (cancelled) {
          return
        }
        reportedScreenRef.current = screen
        surface.reportSessionOptions(reportedValues)
        return
      }
    }
    void reportCurrentValues()
    return () => {
      cancelled = true
    }
  }, [agent, discoveryContext, readTerminalScreen, surface, targetPtyId])

  // Scope survives surface rebuilds; reapplying an unchanged report would revert the user’s pick.
  useEffect(() => {
    appliedReportedModelRef.current = null
  }, [agent, targetPtyId, terminalTabId])

  useEffect(() => {
    // Claude uses terminal-frame evidence; other agents report model IDs in status hooks.
    if (!surface || agent === 'claude' || !reportedModel) {
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
  }, [agent, discoveryContext, reportedModel, surface])

  useEffect(() => {
    if (!surface || !discoveryContext) {
      return
    }
    const unsubscribe = subscribeNativeChatEnrichedModels(
      agent,
      discoveryContext.hostKey,
      (models) => {
        surface.replaceModels(models)
        const screen = agent === 'claude' ? reportedScreenRef.current : null
        const reportedValues = screen
          ? readClaudeSessionOptionsFromTerminalScreen(screen, models)
          : null
        if (reportedValues) {
          surface.reportSessionOptions(reportedValues)
        }
        void retirePersistedModelMissingFromDiscovery(agent, models).catch(() => undefined)
      }
    )
    // Subscriptions do not replay; inspect cached discovery so pre-mount probes can retire stale defaults.
    const cached = readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
    if (cached) {
      void retirePersistedModelMissingFromDiscovery(agent, cached).catch(() => undefined)
    }
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
