import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { updateNativeChatSessionOptionDefaults } from '../../../../shared/native-chat-session-option-defaults'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
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
    const reportedValues =
      agent === 'claude' ? readClaudeSessionOptionsFromTerminalScreen(readTerminalScreen?.()) : null
    let settingsWrite = Promise.resolve()
    return createNativeChatPtySessionOptions({
      agent,
      scopeKey,
      ...(targetPtyId ? { fallbackScopeKey: terminalTabId } : {}),
      ...(discoveryContext
        ? {
            initialModels:
              readNativeChatEnrichedModels(agent, discoveryContext.hostKey) ?? undefined
          }
        : {}),
      mode: targetPtyId ? 'live' : 'draft',
      reportedValues,
      dispatchCommand,
      onAgentPicker,
      persistSelection: async ({ modelId, optionId, value }) => {
        // Why: read the live persisted defaults at write time (after any prior
        // write in this chain settles) and merge only this selection onto them,
        // rather than a baseline captured once at surface creation. A frozen
        // baseline would let a second same-agent pane's write be clobbered,
        // since updateSettings shallow-merges nativeChatSessionOptions. Chaining
        // still keeps rapid consecutive picks in selection order.
        settingsWrite = settingsWrite
          .catch(() => undefined)
          .then(() => {
            const base = useAppStore.getState().settings?.nativeChatSessionOptions
            const next = updateNativeChatSessionOptionDefaults({
              persisted: base,
              agent,
              modelId,
              optionId,
              value
            })
            return useAppStore.getState().updateSettings({ nativeChatSessionOptions: next })
          })
        await settingsWrite
      }
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
      const reportedValues =
        readClaudeSessionOptionsFromTerminalScreen(authoritativeScreen) ??
        readClaudeSessionOptionsFromTerminalScreen(readTerminalScreen?.())
      if (!cancelled && reportedValues) {
        surface.reportSessionOptions(reportedValues)
      }
    }
    void reportCurrentValues()
    return () => {
      cancelled = true
    }
  }, [agent, readTerminalScreen, surface, targetPtyId])

  useEffect(() => {
    if (!surface || !discoveryContext) {
      return
    }
    const unsubscribe = subscribeNativeChatEnrichedModels(
      agent,
      discoveryContext.hostKey,
      (models) => surface.replaceModels(models)
    )
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
