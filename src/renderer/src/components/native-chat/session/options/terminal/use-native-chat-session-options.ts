import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog'
import { matchNativeChatCatalogModelId } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-state'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import { sayNativeChatSessionOptionTranslated } from '../controls/native-chat-session-option-labels-text'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { NativeChatSessionOptionDispatchCommand } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-dispatch'
import {
  ensureNativeChatModelEnrichment,
  nativeChatModelDiscoveryListedNothing,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from '../catalog/native-chat-session-option-enrichment'
import {
  discoverNativeChatCatalogModels,
  resolveNativeChatModelDiscoveryContext
} from '../catalog/native-chat-session-option-discovery'
import {
  readClaudeSessionOptionsFromResponse,
  readClaudeSessionOptionsFromTerminalScreen,
  type ClaudeResponseEvidence
} from './claude-terminal-session-options'

import { enqueueSessionOptionSettingsWrite } from '../native-chat-session-option-settings-write'

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

const CLIENT_SETTINGS_TARGET = { kind: 'local' } as const

/** The newest response, bound to the surface it was committed for. */
type CommittedClaudeResponse = {
  surface: NativeChatPtySessionOptionsSurface
  response: ClaudeResponseEvidence
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
  /** Claude: the newest transcript response, which still names the model after the frame scrolls away. */
  claudeResponse?: ClaudeResponseEvidence | null
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
    paneKey,
    claudeResponse
  } = args
  const status = useAgentStatus(paneKey)
  const reportedModel = status?.model ?? null
  const canSwitchOmpModel = status?.modelSwitchCommand === 'orca-model'
  // Only changed hook models are new evidence; repeated status pings must not undo newer user picks.
  const appliedReportedModelRef = useRef<string | null>(null)
  // Cache parsed screen text so late discovery can resolve real host model IDs.
  const reportedScreenRef = useRef<string | null>(null)
  const responseRef = useRef<CommittedClaudeResponse | null>(null)
  const discoveryContext = useMemo(
    () => resolveNativeChatModelDiscoveryContext(terminalTabId),
    [terminalTabId]
  )
  const built = useMemo(() => {
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
    const surface = createNativeChatPtySessionOptions({
      agent,
      scopeKey,
      ...(targetPtyId ? { fallbackScopeKey: terminalTabId } : {}),
      // Version-neutral family seeds keep the picker available while host discovery runs or fails.
      ...(discoveryContext ? { initialModels: discoveredModels ?? undefined } : {}),
      mode: targetPtyId ? 'live' : 'draft',
      modelLabel: sayNativeChatSessionOptionTranslated('model'),
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
    return { surface, builtWithListing: discoveredModels !== null }
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
  const surface = built?.surface ?? null
  const builtWithListing = built?.builtWithListing ?? false

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

  const responseModel = claudeResponse?.model
  const responseEffort = claudeResponse?.effort
  // Written at commit: a discovery callback between commit and passive effects must see this response.
  useLayoutEffect(() => {
    responseRef.current =
      surface && responseModel
        ? {
            surface,
            response: {
              model: responseModel,
              ...(responseEffort ? { effort: responseEffort } : {})
            }
          }
        : null
  }, [responseEffort, responseModel, surface])
  useEffect(() => {
    if (!surface || agent !== 'claude') {
      return
    }
    if (!discoveryContext) {
      fillClaudeModelFromResponse(surface, responseRef.current)
      return
    }
    // Before the host listing arrives the response's API id would become an option-less stand-in.
    const models = readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
    if (models || nativeChatModelDiscoveryListedNothing(agent, discoveryContext.hostKey)) {
      fillClaudeModelFromResponse(surface, responseRef.current, models ?? undefined)
    }
  }, [agent, discoveryContext, responseEffort, responseModel, surface])

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
    const applyModels = (models: CatalogModel[]): void => {
      surface.replaceModels(models)
      const screen = agent === 'claude' ? reportedScreenRef.current : null
      const reportedValues = screen
        ? readClaudeSessionOptionsFromTerminalScreen(screen, models)
        : null
      if (reportedValues) {
        surface.reportSessionOptions(reportedValues)
      } else if (agent === 'claude') {
        fillClaudeModelFromResponse(surface, responseRef.current, models)
      }
    }
    const unsubscribe = subscribeNativeChatEnrichedModels(
      agent,
      discoveryContext.hostKey,
      applyModels
    )
    // A listing that settled after the surface was built is never notified again; one present at build is already applied.
    const settled = builtWithListing
      ? null
      : readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
    if (settled) {
      applyModels(settled)
    }
    let active = true
    void ensureNativeChatModelEnrichment({
      agent,
      hostKey: discoveryContext.hostKey,
      discover: () =>
        discoverNativeChatCatalogModels(agent, discoveryContext.runtime, discoveryContext.hostKey)
    }).then(() => {
      // A failed or empty probe notifies no listener, so a waiting response would never be named.
      if (
        active &&
        agent === 'claude' &&
        nativeChatModelDiscoveryListedNothing(agent, discoveryContext.hostKey)
      ) {
        fillClaudeModelFromResponse(surface, responseRef.current)
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [agent, builtWithListing, discoveryContext, surface])

  const snapshot = useSyncExternalStore(
    surface?.subscribe ?? subscribeEmpty,
    surface?.getSnapshot ?? getEmptySnapshot,
    surface?.getSnapshot ?? getEmptySnapshot
  )
  return { surface, snapshot }
}

function shownModelId(surface: NativeChatPtySessionOptionsSurface): string | undefined {
  const kind = surface.getSnapshot().find((descriptor) => descriptor.id === 'model')?.kind
  return kind?.type === 'select' ? kind.currentValue : undefined
}

/** Only fill an unknown model: a startup frame or a pick made in chat stays authoritative. */
function fillClaudeModelFromResponse(
  surface: NativeChatPtySessionOptionsSurface,
  committed: CommittedClaudeResponse | null,
  models?: readonly CatalogModel[]
): void {
  // A callback of a replaced surface runs until passive cleanup; it must not take the new session's response.
  if (committed?.surface === surface && !shownModelId(surface)) {
    surface.reportSessionOptions(readClaudeSessionOptionsFromResponse(committed.response, models))
  }
}
