import { useAppStore } from '@/store'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AgentLaunchResumeRequest } from '../../../shared/agent-launch-spawn-request'

export type ResumeSleepingAgentSessionsOptions = {
  suppressNavigation?: boolean
  /** Provider-session claim keys already woken in place by mounted panes
   *  (WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT). Their sleeping records are
   *  cleared only after the in-place spawn succeeds, so the generic resume
   *  must neither launch nor clear them here. */
  skipClaimKeys?: ReadonlySet<string>
  /** Called with the tab id of each freshly launched resume tab, so
   *  navigation-suppressed callers can background-mount exactly those tabs. */
  onSessionLaunched?: (tabId: string) => void
}

function appendTabToWorktreeOrder(worktreeId: string, tabId: string): void {
  const state = useAppStore.getState()
  const termIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = state.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((f) => f.id)
  const browserIds = (state.browserTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
  const base = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tabId)
  order.push(tabId)
  state.setTabBarOrder(worktreeId, order)
}

// Why: mobile-driven wake runs on the desktop host renderer, so it must create
// the resume tab without stealing the desktop's active worktree/tab/view.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  // Why: resume travels by session ownership key only. The host loads the
  // private record and resolves command/env/launchConfig/token itself, returning
  // them through the launched receipt; the client never assembles resume argv.
  // The key is base-collapsed (baseAgent, not the requested custom id), so two
  // custom ids on one base resume the same owner.
  const baseAgent = record.baseAgent ?? record.agent
  const agentLaunch: AgentLaunchResumeRequest = {
    resume: {
      operation: 'resume',
      sessionKey: {
        worktreeId: record.worktreeId,
        baseAgent,
        providerSessionId: record.providerSession.id
      }
    }
  }
  // Why: the tab re-displays the ORIGINALLY requested identity (the custom id, if
  // any) while ownership/telemetry stay on the resumable base.
  const requestedAgent = record.requestedAgent ?? record.agent

  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    launchAgent: requestedAgent,
    ...(options?.suppressNavigation ? { activate: false, recordInteraction: false } : {})
  })
  state.queueTabStartupCommand(tab.id, {
    command: '',
    agentLaunch,
    // Why: one-release legacy handoff. A pre-U5 record carries `launchConfig` (new
    // host-owned records do not); surrender it plus its recorded execution owner so
    // the host can prove the opaque command still targets the same host and ingest
    // it on first resume. With `agentLaunch` present the host ignores these until
    // its ingest lands, so this is contract-compatible today and functional the
    // moment the ingest ships — no second renderer pass.
    // Deletion trigger: legacy `launchConfig` field retirement (U10 cleanup).
    ...(record.launchConfig
      ? {
          launchConfig: record.launchConfig,
          agentArgsOverride: record.launchConfig.agentArgs,
          legacyResumeRecordedConnectionId: record.connectionId ?? null
        }
      : {}),
    // Why: launchAgent + resumeProviderSession stay renderer-side — the resume
    // replay-protection dedup reads them from pendingStartupByTabId to avoid
    // double-launching a provider session that is already queued.
    resumeProviderSession: record.providerSession,
    launchAgent: requestedAgent,
    sleepingRecordPaneKey: record.paneKey,
    showSessionRestoredBanner: true,
    telemetry: {
      agent_kind: tuiAgentToAgentKind(baseAgent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  })
  state.claimAutomaticAgentResume(tab.id, {
    worktreeId: record.worktreeId,
    launchAgent: requestedAgent,
    providerSession: record.providerSession
  })
  // Why: the record is NOT cleared here. The host resolves the launch after the
  // pane mounts, so it can still fail (or land unverifiable on contact loss);
  // clearing now would strand the session with no retry record. Consumption of
  // the queued startup — spent only once the pane owns a concrete PTY — clears
  // it via sleepingRecordPaneKey; until then the sweep's replay dedup skips it.
  if (!options?.suppressNavigation) {
    state.setActiveTabType('terminal')
  }
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  options?.onSessionLaunched?.(tab.id)
  return true
}
