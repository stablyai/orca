import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useAppStore } from '@/store'
import {
  registerWorkspaceSurfaceProducer,
  type WorkspaceSurfaceProducer
} from '@/lib/workspace-surface-production'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { queueStandaloneSetupTab } from '@/lib/worktree-setup-issue-command-queue'
import { settleStructuredAgentSurfaceProducer } from '@/lib/structured-agent-surface-production'

type StandaloneSetupArgs = Parameters<typeof queueStandaloneSetupTab>[0]

export function beginFullCreationSurfaceProduction(
  args: Omit<StandaloneSetupArgs, 'store'> & { structuredLaunch: boolean }
): { producer: WorkspaceSurfaceProducer | null; setupRunsWithoutPrimary: boolean } {
  const store = useAppStore.getState()
  const producer = args.structuredLaunch
    ? registerWorkspaceSurfaceProducer({
        workspaceKey: args.worktreeId,
        executionHostId: getExecutionHostIdForWorktree(store, args.worktreeId)
      })
    : null
  try {
    const setupRunsWithoutPrimary = producer !== null && queueStandaloneSetupTab({ ...args, store })
    return { producer, setupRunsWithoutPrimary }
  } catch (error) {
    producer?.failed(error)
    throw error
  }
}

export function settleFullCreationSurfaceProduction(
  producer: WorkspaceSurfaceProducer | null,
  worktreeId: string,
  settlement: StructuredAgentLaunchSettlement | null
): void {
  if (producer) {
    settleStructuredAgentSurfaceProducer(producer, worktreeId, settlement)
  }
}

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
