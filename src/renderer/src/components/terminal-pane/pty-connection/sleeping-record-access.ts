import { useAppStore } from '@/store'
import type { PtyConnectResult } from '../pty-transport'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { parseLegacyNumericPaneKey } from '../../../../../shared/stable-pane-id'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import { recognizeAgentProcessFromCommandLine } from '../../../../../shared/agent-process-recognition'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { resolveTuiAgentConfig } from '../../../../../shared/custom-tui-agents'
import {
  beginAgentStartupDeliveryAttempt,
  releaseAgentStartupDeliveryAttempt
} from '@/lib/agent-startup-delayed-delivery'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installCommandInferredPaneAgent } from './command-inferred-pane-agent'

export function installSleepingRecordAccess(session: ConnectPanePtySession): void {
  session.getSleepingRecordForPane = (
    state: ReturnType<typeof useAppStore.getState>
  ): { paneKey: string; record: SleepingAgentSessionRecord } | null => {
    const stableRecord = state.sleepingAgentSessionsByPaneKey[session.cacheKey]
    if (stableRecord) {
      return { paneKey: session.cacheKey, record: stableRecord }
    }
    const legacyMatches = Object.entries(state.sleepingAgentSessionsByPaneKey).filter(
      ([paneKey, record]) => {
        const legacy = parseLegacyNumericPaneKey(paneKey)
        return (
          legacy?.tabId === session.deps.tabId &&
          record.worktreeId === session.deps.worktreeId &&
          (!record.tabId || record.tabId === session.deps.tabId)
        )
      }
    )
    const exactLegacyMatch = legacyMatches.find(([paneKey]) => {
      const legacy = parseLegacyNumericPaneKey(paneKey)
      return legacy?.numericPaneId === String(session.pane.id)
    })
    const providerSessionKeys = new Set(
      legacyMatches.map(([, record]) => getProviderSessionClaimKey(record))
    )
    const oldestLegacyMatch = legacyMatches
      .slice()
      .sort(([, a], [, b]) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)[0]
    // Why: duplicate legacy aliases can point at one provider session; consume
    // the oldest capture as canonical and clear its aliases after resume.
    const selectedLegacyMatch =
      exactLegacyMatch ??
      (providerSessionKeys.size === 1
        ? legacyMatches.length === 1
          ? legacyMatches[0]
          : oldestLegacyMatch
        : null)
    if (!selectedLegacyMatch) {
      return null
    }
    const [paneKey, record] = selectedLegacyMatch
    return { paneKey, record }
  }
  session.isLegacyWorkerAutomaticResumeBlocked = (): boolean =>
    session.getSleepingRecordForPane(useAppStore.getState())?.record.automaticResumeBlockedBy ===
    'legacy-orchestration-worker'
  session.clearSleepingRecordProviderDuplicates = (
    state: ReturnType<typeof useAppStore.getState>,
    consumed: { paneKey: string; record: SleepingAgentSessionRecord }
  ): void => {
    state.clearSleepingAgentSession(consumed.paneKey)
    for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
      if (
        paneKey !== consumed.paneKey &&
        record.worktreeId === consumed.record.worktreeId &&
        record.agent === consumed.record.agent &&
        agentProviderSessionsEqual(
          record.agent,
          record.providerSession,
          consumed.record.providerSession
        )
      ) {
        // Why: legacy pane aliases can leave multiple sleeping rows for one
        // provider session; once this pane resumes it, every alias is stale.
        state.clearSleepingAgentSession(paneKey)
      }
    }
  }
  session.launchToken = session.paneStartup?.launchConfig
    ? (session.paneStartup.launchToken ?? createBrowserUuid())
    : undefined
  session.startupDraftAgent =
    session.paneStartup?.launchAgent ?? session.paneStartup?.initialAgentStatus?.agent
  const startupDraftSettings = useAppStore.getState().settings
  session.startupDraftAgentConfig = resolveTuiAgentConfig(
    session.startupDraftAgent,
    startupDraftSettings?.customTuiAgents,
    startupDraftSettings?.deletedCustomTuiAgents
  )
  session.startupDraftPrompt =
    typeof session.paneStartup?.draftPrompt === 'string' && session.paneStartup.draftPrompt.trim()
      ? session.paneStartup.draftPrompt
      : null
  session.startupDraftPromptNeedsPaste =
    session.startupDraftPrompt !== null &&
    !session.startupDraftAgentConfig?.draftPromptFlag &&
    !session.startupDraftAgentConfig?.draftPromptEnvVar
  session.startupDraftDeliveryClaimed = false
  session.startupDraftPasteAttempted = false
  session.claimStartupDraftPasteDelivery = (): boolean => {
    if (!session.startupDraftPromptNeedsPaste || session.launchToken === undefined) {
      return false
    }
    if (session.startupDraftDeliveryClaimed) {
      return true
    }
    // Why: launch-bound draft paste needs a launch token; all current
    // draftPrompt startup callers pair it with launchConfig so this can safely
    // fence off delayed sidecar delivery before Codex's first composer frame.
    session.startupDraftDeliveryClaimed = beginAgentStartupDeliveryAttempt({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      launchToken: session.launchToken
    })
    return session.startupDraftDeliveryClaimed
  }
  session.releaseUnattemptedStartupDraftPasteDelivery = (): void => {
    if (
      !session.startupDraftDeliveryClaimed ||
      session.startupDraftPasteAttempted ||
      session.launchToken === undefined
    ) {
      return
    }
    releaseAgentStartupDeliveryAttempt({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      launchToken: session.launchToken
    })
    session.startupDraftDeliveryClaimed = false
  }
  // Why: reserve before deferred connect so the creation sidecar cannot time out during setup and strand this pane's live scanner.
  session.ownsStartupDraftPaste = session.claimStartupDraftPasteDelivery()
  if (session.paneStartup?.launchConfig) {
    useAppStore
      .getState()
      .registerAgentLaunchConfig(session.cacheKey, session.paneStartup.launchConfig, {
        agentType: session.paneStartup.launchAgent ?? session.paneStartup.initialAgentStatus?.agent,
        ...(session.launchToken ? { launchToken: session.launchToken } : {}),
        tabId: session.deps.tabId,
        leafId: session.pane.leafId
      })
  } else if (session.paneStartup) {
    useAppStore.getState().clearAgentLaunchConfig(session.cacheKey)
  }
  session.registerEffectiveLaunchConfig = (
    effectiveLaunchConfig: PtyConnectResult['launchConfig'] | undefined,
    metadata?: { launchToken?: string; launchAgent?: TuiAgent }
  ): void => {
    if (!effectiveLaunchConfig) {
      if (metadata?.launchAgent) {
        // Why: daemon launch identity can outlive the process while Orca is
        // closed. Use it to request confirmation, never as current byte authority.
        useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
          agent: metadata.launchAgent,
          shellForeground: false
        })
      }
      return
    }
    // Why: daemon reattach preserves the pane's exact launch command but not
    // renderer metadata; recover only allowlisted command identity from it.
    const persistedLaunchAgent = recognizeAgentProcessFromCommandLine(
      effectiveLaunchConfig.agentCommand
    )?.agent
    useAppStore.getState().registerAgentLaunchConfig(session.cacheKey, effectiveLaunchConfig, {
      agentType:
        metadata?.launchAgent ??
        session.paneStartup?.launchAgent ??
        session.paneStartup?.initialAgentStatus?.agent ??
        persistedLaunchAgent,
      ...((metadata?.launchToken ?? session.launchToken)
        ? { launchToken: metadata?.launchToken ?? session.launchToken }
        : {}),
      tabId: session.deps.tabId,
      leafId: session.pane.leafId
    })
  }
  session.clearRegisteredStartupLaunchConfig = (): void => {
    useAppStore.getState().clearAgentLaunchConfig(session.cacheKey)
  }
  session.neutralTerminalTitle = (): string => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )
    return tab?.defaultTitle?.trim() || 'Terminal'
  }
  installCommandInferredPaneAgent(session)
}
