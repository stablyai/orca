import { useAppStore } from '@/store'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'
import type { PtyConnectResult } from '../pty-transport'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

export function applyFreshSpawnAgentLaunchResult(
  session: ConnectPanePtySession,
  result: PtyConnectResult,
  coldRestore: ColdRestoreAgentResumeStartup | null
): void {
  const receipt = result.agentLaunch?.status === 'launched' ? result.agentLaunch.receipt : null
  if (receipt) {
    session.launchToken = receipt.launchToken
    useAppStore.getState().backfillTabLaunchAgent(session.deps.tabId, receipt.requestedAgent)
    if (receipt.notices.length > 0) {
      useAppStore.getState().attachLaunchNotices({
        worktreeId: session.deps.worktreeId,
        tabId: session.deps.tabId,
        launchToken: receipt.launchToken,
        notices: receipt.notices
      })
    }
  }
  if (result.launchNotices) {
    useAppStore.getState().attachLaunchNotices({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      launchToken: result.launchNotices.launchToken,
      notices: result.launchNotices.notices
    })
  }
  session.registerEffectiveLaunchConfig(result.launchConfig, {
    ...(coldRestore?.launchToken ? { launchToken: coldRestore.launchToken } : {}),
    ...(receipt ? { launchToken: receipt.launchToken } : {}),
    ...(coldRestore ? { launchAgent: coldRestore.agent } : {}),
    ...(receipt ? { launchAgent: receipt.baseAgent } : {})
  })
  const followupPrompt = result.followupPrompt ?? null
  const prompt = followupPrompt ?? result.draftPrompt ?? null
  const agent = receipt?.baseAgent ?? session.paneStartup?.launchAgent
  if (session.startupDraftPromptNeedsPaste || !agent || !prompt) {
    return
  }
  void pasteDraftWhenAgentReady({
    tabId: session.deps.tabId,
    content: prompt,
    agent,
    submit: followupPrompt !== null,
    forcePaste: true,
    onTimeout: () => showAutomationPromptNotSentToast(agent)
  }).catch(() => {})
}
