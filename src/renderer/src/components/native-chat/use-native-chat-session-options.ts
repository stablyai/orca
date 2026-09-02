import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import {
  clearNativeChatSessionOptionModel,
  updateNativeChatSessionOptionDefaults
} from '../../../../shared/native-chat-session-option-defaults'
import type {
  PersistedNativeChatSessionOptions,
  SessionOptionDescriptor
} from '../../../../shared/native-chat-session-options'
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

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

/**
 * Why: every nativeChatSessionOptions writer — a pick from any pane, a probe
 * retirement — serializes on this one chain and re-reads live settings at apply
 * time. updateSettings shallow-merges the whole object, so an interleaved write
 * from a snapshot captured earlier would silently clobber a concurrent pick.
 * The update runs against the settled base and may return null to skip writing.
 */
let settingsWrite: Promise<unknown> = Promise.resolve()
function enqueueSessionOptionSettingsWrite(
  update: (
    base: PersistedNativeChatSessionOptions | undefined
  ) => PersistedNativeChatSessionOptions | null
): Promise<void> {
  const write = settingsWrite
    .catch(() => undefined)
    .then(() => {
      const next = update(useAppStore.getState().settings?.nativeChatSessionOptions)
      return next
        ? useAppStore.getState().updateSettings({ nativeChatSessionOptions: next })
        : undefined
    })
  settingsWrite = write
  return write
}

/**
 * Why: the picker drops a retired model, but the persisted default is what launches
 * become `-m <id>` — every launch site reads it, including the ones that never show
 * the picker. Left alone the id is invisible and still fatal, so an authoritative
 * probe that no longer lists it must retire it here too.
 */
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
  await enqueueSessionOptionSettingsWrite((persisted) => {
    const modelId = persisted?.[agent]?.model
    return typeof modelId === 'string' && modelId && !models.some((model) => model.id === modelId)
      ? clearNativeChatSessionOptionModel(persisted, agent)
      : null
  })
}

export function useNativeChatSessionOptions(args: {
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  readTerminalScreen?: () => string | null
}): {
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const { agent, terminalTabId, targetPtyId, dispatchCommand, onAgentPicker, readTerminalScreen } =
    args
  // The screen text that last parsed into reported values, so a later model
  // discovery can re-resolve it against the host's real ids.
  const reportedScreenRef = useRef<string | null>(null)
  const discoveryContext = useMemo(
    () => resolveNativeChatModelDiscoveryContext(terminalTabId),
    [terminalTabId]
  )
  const surface = useMemo(() => {
    // Why: native chat currently attaches only after startup is already queued;
    // exposing a draft picker here would claim it can still mutate that command.
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
      // Why: the catalog seed carries version-neutral family labels, so it is
      // safe on every host while the once-per-host probe runs or after it fails
      // — without it the whole picker would pop in late or never appear.
      ...(discoveryContext ? { initialModels: discoveredModels ?? undefined } : {}),
      mode: targetPtyId ? 'live' : 'draft',
      reportedValues,
      dispatchCommand,
      onAgentPicker,
      persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault }) =>
        enqueueSessionOptionSettingsWrite((persisted) =>
          updateNativeChatSessionOptionDefaults({
            persisted,
            agent,
            modelId,
            optionId,
            value,
            adoptModelAsLaunchDefault
          })
        )
    })
  }, [
    agent,
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
          // Why: the API snapshots the main buffer, which is stale while a TUI
          // owns the alternate screen. The mounted xterm is authoritative then.
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
        // Why: discovery can land after this read. Keeping the screen that
        // parsed lets it re-resolve against the host's real ids later, when the
        // frame itself may have already scrolled out of the buffer.
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
        // A failed settings write must not surface as an unhandled rejection.
        void retirePersistedModelMissingFromDiscovery(agent, models).catch(() => undefined)
      }
    )
    // Why: the subscription never replays, so a probe that settled before this
    // pane mounted would leave a retired persisted model in place forever.
    const cached = readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
    if (cached) {
      void retirePersistedModelMissingFromDiscovery(agent, cached).catch(() => undefined)
    }
    ensureNativeChatModelEnrichment({
      agent,
      hostKey: discoveryContext.hostKey,
      discover: () => discoverNativeChatCatalogModels(agent, discoveryContext.runtime)
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
