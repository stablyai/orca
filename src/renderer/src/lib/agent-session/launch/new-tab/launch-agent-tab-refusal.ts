import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-args'
import type { AgentTabLaunchOutcome } from './launch-agent-in-new-tab-host-agents'

/** One owner presents a refusal: the caller's visible surface, or the launch action's toast. */
export function refuseAgentTabLaunch(
  args: Pick<LaunchAgentInNewTabArgs, 'focusIntent' | 'presentsRefusal'>,
  recovery: string,
  notify: () => void,
  notifyFailure: boolean
): AgentTabLaunchOutcome {
  args.focusIntent?.cancel()
  if (notifyFailure && !args.presentsRefusal) {
    notify()
  }
  return {
    refused: { delivered: false, failureNotified: notifyFailure || Boolean(args.presentsRefusal) },
    ...(args.presentsRefusal ? { recovery } : {})
  }
}
