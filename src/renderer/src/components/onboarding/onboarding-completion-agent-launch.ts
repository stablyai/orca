import { useAppStore } from '@/store'
import { resolveDefaultAgentForWorktree } from '@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts'
import { agentTabLaunchStore } from '@/lib/agent-session/launch/new-tab/launch-agent-execution-context'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-session/launch/routing/agent-launch-request-id'
import { captureAgentTabLaunchContext } from '@/components/agent-tab-launch-context'
import { activateAndRevealWorkspaceWithOutcome } from '@/lib/workspace/activation/worktree-activation'
import { reportAgentWorkspaceActivation } from '@/lib/workspace/activation/worktree-activation-outcome'

export async function launchOnboardingCompletionAgent(
  worktreeId: string,
  agent: TuiAgent | null | undefined,
  workspaceExecutionHostId?: ExecutionHostId
): Promise<void> {
  if (agent === undefined) {
    agent = await resolveDefaultAgentForWorktree(
      () => agentTabLaunchStore(useAppStore.getState(), { worktreeId, workspaceExecutionHostId }),
      worktreeId
    ).catch(() => null)
  }
  if (!agent) {
    return
  }
  launchAgentInNewTabWithOutcome({
    requestId: newAgentLaunchRequestId(),
    ...captureAgentTabLaunchContext(worktreeId),
    agent,
    worktreeId,
    workspaceExecutionHostId,
    launchSource: 'onboarding',
    beforeSurfaceOpen: () =>
      reportAgentWorkspaceActivation(
        activateAndRevealWorkspaceWithOutcome(worktreeId, {
          agent,
          providesInitialSurface: true,
          executionHostId: workspaceExecutionHostId,
          sidebarRevealBehavior: 'auto'
        }),
        agent
      )
  })
}
