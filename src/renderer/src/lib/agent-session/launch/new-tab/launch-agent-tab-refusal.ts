import {
  agentLaunchRecoveryMessage,
  notifyAgentLaunchFailure
} from '@/lib/agent-session/launch/failure/agent-launch-failure'
import type { ExecutionHostPlatformFact } from '@/runtime/hosts/platform/execution-host-platform-fact'
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

export function refuseUnavailableAgentTabLaunch(
  args: Pick<LaunchAgentInNewTabArgs, 'agent' | 'focusIntent' | 'presentsRefusal'>,
  unavailable: Extract<ExecutionHostPlatformFact, { kind: 'withheld' }>,
  notifyFailure: boolean
): AgentTabLaunchOutcome {
  // A host still connecting is a wait: keep the prompt and handle the attempt without a message.
  if (unavailable.pending) {
    args.focusIntent?.cancel()
    return { refused: { delivered: false, failureNotified: true } }
  }
  const recovery = agentLaunchRecoveryMessage(unavailable.recovery)
  return refuseAgentTabLaunch(
    args,
    recovery,
    () => notifyAgentLaunchFailure(args.agent, recovery),
    notifyFailure
  )
}
