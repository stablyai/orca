import { installSavedResumeStartupCancellation } from './saved-resume-startup-cancellation'
import { launchConfigsEqual } from '../../../../../shared/agent-resume-record-equivalence'
import { useAppStore } from '@/store'
import type { PtyConnectResult } from '../pty-transport-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { findLegacyNumericSleepingRecord } from '../../../../../shared/sleeping-record-legacy-pane-key'
import { neutralTerminalTitle } from '../../../../../shared/terminal-pane-title-reset'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import { recognizeAgentProcessFromCommandLine } from '../../../../../shared/agent-process-recognition'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'
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
    const legacy = findLegacyNumericSleepingRecord(
      state.sleepingAgentSessionsByPaneKey,
      { tabId: session.deps.tabId, numericPaneId: String(session.pane.id) },
      (record) => record.worktreeId === session.deps.worktreeId
    )
    return legacy ? { paneKey: legacy.paneKey, record: legacy.record } : null
  }
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
        // Consume every alias of the resumed provider session so legacy rows cannot resume it twice.
        state.clearSleepingAgentSession(paneKey)
      }
    }
  }
  session.savedStartupAutomaticClaim = session.paneStartup?.resumeSource
    ? useAppStore.getState().automaticAgentResumeClaimsByTabId[session.deps.tabId]
    : undefined
  session.launchToken = session.paneStartup?.launchConfig
    ? (session.paneStartup.launchToken ?? createBrowserUuid())
    : undefined
  session.startupDraftAgent =
    session.paneStartup?.launchAgent ?? session.paneStartup?.initialAgentStatus?.agent
  session.startupDraftAgentConfig = session.startupDraftAgent
    ? TUI_AGENT_CONFIG[session.startupDraftAgent]
    : null
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
    // Draft callers pair launchConfig with prompt paste; reserve its token before delayed sidecar delivery can race Codex composer startup.
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
    if (session.paneStartup.resumeSource) {
      session.savedStartupLaunchRegistration = {
        source: session.paneStartup.resumeSource,
        entry: useAppStore.getState().agentLaunchConfigByPaneKey[session.cacheKey]
      }
    }
  } else if (session.paneStartup) {
    useAppStore.getState().clearAgentLaunchConfig(session.cacheKey)
  }
  session.registerEffectiveLaunchConfig = (
    effectiveLaunchConfig: PtyConnectResult['launchConfig'] | undefined,
    metadata?: { launchToken?: string; launchAgent?: TuiAgent }
  ): void => {
    if (!effectiveLaunchConfig) {
      if (metadata?.launchAgent) {
        // Daemon launch metadata can outlive its process; it requests confirmation without authorizing bytes.
        const state = useAppStore.getState()
        const current = state.paneForegroundAgentByPaneKey[session.cacheKey]
        // Why: re-mounting a parked pane must not demote this session's own read of the same agent.
        const keepsRead =
          current?.agent === metadata.launchAgent && current.agentEvidence === 'process-read'
        state.setPaneForegroundAgent(session.cacheKey, {
          agent: metadata.launchAgent,
          agentEvidence: keepsRead ? 'process-read' : 'launch-record',
          shellForeground: false
        })
      }
      return
    }
    // Recover only allowlisted command identity because daemon reattach keeps argv but loses renderer metadata.
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
  session.clearRegisteredStartupLaunchConfig = (expected = session.paneStartup): void => {
    const state = useAppStore.getState()
    const installed = state.agentLaunchConfigByPaneKey[session.cacheKey]
    const captured = session.savedStartupLaunchRegistration
    const ownsRegistration = expected?.resumeSource
      ? captured?.source === expected.resumeSource && captured.entry === installed
      : true
    if (
      ownsRegistration &&
      installed &&
      expected?.launchConfig &&
      installed.identity.launchToken === (expected.launchToken ?? session.launchToken) &&
      launchConfigsEqual(installed.launchConfig, expected.launchConfig)
    ) {
      state.clearAgentLaunchConfig(session.cacheKey)
    }
  }
  installSavedResumeStartupCancellation(session)
  session.neutralTerminalTitle = (): string => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )
    return neutralTerminalTitle(tab?.defaultTitle)
  }
  installCommandInferredPaneAgent(session)
}
