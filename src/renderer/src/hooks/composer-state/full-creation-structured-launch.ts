import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'
import { startStructuredCodexLaunch } from '@/lib/structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'

type Activation = ActivateAndRevealResult | false

export async function settleFullCreationStructuredLaunch(args: {
  structuredLaunch: boolean
  agent: TuiAgent
  worktreeId: string
  prompt: string
  initialActivation: Activation
  onDefinitiveRefusal: () => Activation | Promise<Activation>
}): Promise<{
  structuredLaunchAccepted: boolean
  visibilityUnknown: boolean
  activation: Activation
}> {
  let activation = args.initialActivation
  let structuredLaunchAccepted = args.structuredLaunch
  if (!args.structuredLaunch || args.agent !== 'codex') {
    return { structuredLaunchAccepted, visibilityUnknown: false, activation }
  }

  const launch = startStructuredCodexLaunch(args.worktreeId, { prompt: args.prompt })
  const refusalFallback = launch.claimDefinitiveRefusalFallback(async () => {
    structuredLaunchAccepted = false
    activation = await args.onDefinitiveRefusal()
  })
  try {
    const receipt = await launch.launchResult
    activateStructuredAgentSessionById({
      worktreeId: args.worktreeId,
      sessionId: receipt.sessionId
    })
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      await refusalFallback
    } else if (launch.isVisibilityUnknown()) {
      return { structuredLaunchAccepted, visibilityUnknown: true, activation }
    }
  }
  return { structuredLaunchAccepted, visibilityUnknown: false, activation }
}
