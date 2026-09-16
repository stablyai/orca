import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import {
  beginStructuredAgentSessionProvisionalLaunch,
  type StructuredAgentSessionProvisionalLaunch
} from '@/lib/structured-agent-session-provisional-tab'

/** Full-create dialog: the structured launch plus what this flow did before structured chat
 *  existed. Returns null when no visible surface can be owned. */
export function beginFullCreationStructuredLaunch(args: {
  /** Planned before the worktree existed; `worktreeId` names the one that was created. */
  plan: AgentSessionLaunchPlan
  worktreeId: string
  beforeOpen: (sessionId: string) => boolean | void
}): StructuredAgentSessionProvisionalLaunch | null {
  return beginStructuredAgentSessionProvisionalLaunch({
    plan: args.plan,
    hooks: {},
    target: { worktreeId: args.worktreeId },
    beforeOpen: args.beforeOpen
  })
}
