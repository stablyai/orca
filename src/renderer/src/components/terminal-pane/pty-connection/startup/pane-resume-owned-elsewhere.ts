import { useAppStore } from '@/store/index'
import { writeTerminalOutput } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentSessionRecord
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { stablePaneHasLivePty } from '@/lib/agent-session/resume/sleeping-agent-pane-ownership'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { PendingStartupCommand } from './fresh-spawn-types'
import { paneResumeRecord } from './pane-resume-record'

const SESSION_RUNNING_ELSEWHERE_NOTICE =
  '\r\n\x1b[2mThis agent session is already running in another tab.\x1b[0m\r\n'

function providerSessionLiveInAnotherPane(resume: SleepingAgentSessionRecord): boolean {
  const state = useAppStore.getState()
  return Array.from(state.agentStatusByPaneKey.values()).some((entry) => {
    const pane = entry.paneKey === resume.paneKey ? null : parsePaneKey(entry.paneKey)
    return (
      pane !== null &&
      entry.agentType === resume.agent &&
      agentProviderSessionsEqual(resume.agent, entry.providerSession, resume.providerSession) &&
      stablePaneHasLivePty(
        pane.tabId,
        pane.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId[pane.tabId]
      )
    )
  })
}

function providerSessionQueuedInAnotherTab(
  resume: SleepingAgentSessionRecord,
  ownTabId: string
): boolean {
  const state = useAppStore.getState()
  const sameSession = (
    agent: string | undefined,
    providerSession: AgentProviderSessionMetadata | undefined
  ): boolean =>
    agent === resume.agent &&
    agentProviderSessionsEqual(resume.agent, providerSession, resume.providerSession)
  return (
    Object.entries(state.pendingStartupByTabId).some(
      ([tabId, startup]) =>
        tabId !== ownTabId && sameSession(startup.launchAgent, startup.resumeProviderSession)
    ) ||
    Object.entries(state.automaticAgentResumeClaimsByTabId).some(
      ([tabId, claim]) =>
        tabId !== ownTabId && sameSession(claim.launchAgent, claim.providerSession)
    )
  )
}

/** A settled failure may already have recovered in another pane before this Retry. */
export function skipPaneResumeOwnedElsewhere(
  session: ConnectPanePtySession,
  startupOverride: PendingStartupCommand | null | undefined
): boolean {
  const resume = paneResumeRecord(session, startupOverride)
  if (
    !resume ||
    (!providerSessionLiveInAnotherPane(resume) &&
      !providerSessionQueuedInAnotherTab(resume, session.deps.tabId))
  ) {
    return false
  }
  writeTerminalOutput(session.pane.terminal, SESSION_RUNNING_ELSEWHERE_NOTICE, {
    foreground: session.deps.isVisibleRef.current === true
  })
  return true
}
