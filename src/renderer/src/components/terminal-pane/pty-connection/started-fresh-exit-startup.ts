import { useAppStore } from '@/store'
import {
  isResumableTuiAgent,
  type TerminalLaunchResult
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { buildAgentRecipeFreshLaunch } from '../../../../../shared/tui-agent-resume-startup'
import { resolveResumeLaunchRecipe } from '../../../../../shared/tui-agent-launch-defaults'
import { resolvePaneResumeLaunchTarget } from './cold-restore-resume-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installStartedFreshExitStartup(session: ConnectPanePtySession): void {
  /** Main replaced this start's saved resume with a fresh agent; a retry after its exit relaunches
   *  that fresh agent from the same recipe, never the replaced resume. */
  session.reconcileExitStartupAfterFreshStart = (result: TerminalLaunchResult): void => {
    const exit = session.currentProcessExitState
    const startup = exit?.startup
    const agent = startup?.launchAgent
    if (!startup?.resumeProviderSession || !result.launchConfig || !isResumableTuiAgent(agent)) {
      return
    }
    const state = useAppStore.getState()
    const target = resolvePaneResumeLaunchTarget(session, state)
    const fresh = buildAgentRecipeFreshLaunch({
      agent,
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      platform: target.platform,
      agentHostPlatform: target.agentHostPlatform,
      shell: target.shell,
      ...resolveResumeLaunchRecipe(result.launchConfig)
    })
    if (!fresh) {
      return
    }
    const {
      resumeProviderSession: _resumed,
      resumeOrigin: _origin,
      resumeSource: _source,
      ...launch
    } = startup
    exit.startup = { ...launch, command: fresh.command, launchConfig: fresh.launchConfig }
  }
}
