import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** Full-create dialog: the structured launch plus what this flow did before structured chat
 *  existed. Returns null when the plan's route is not structured. */
export async function settleFullCreationStructuredLaunch(args: {
  /** Planned before the worktree existed; `worktreeId` names the one that was created. */
  plan: AgentSessionLaunchPlan
  agent: TuiAgent
  worktreeId: string
  startup: WorktreeStartupPayload | undefined
  pendingFirstAgentMessageRename: boolean
  applyWorktreeMeta: (
    worktreeId: string,
    meta: { pendingFirstAgentMessageRename: boolean }
  ) => Promise<void>
}): Promise<StructuredAgentLaunchSettlement | null> {
  return args.plan.launch(
    {
      legacyFallback: async () => {
        if (args.pendingFirstAgentMessageRename) {
          await args
            .applyWorktreeMeta(args.worktreeId, { pendingFirstAgentMessageRename: true })
            .catch(() => undefined)
        }
        const activation = activateAndRevealWorktree(args.worktreeId, {
          sidebarRevealBehavior: 'auto',
          agent: args.agent,
          createNewTerminalForStartup: true,
          ...(args.startup ? { startup: args.startup } : {})
        })
        return { activation, primaryTabId: activation === false ? null : activation.primaryTabId }
      },
      onStructuredReady: (sessionId) =>
        activateStructuredAgentSessionById({ worktreeId: args.worktreeId, sessionId })
    },
    { worktreeId: args.worktreeId }
  )
}
