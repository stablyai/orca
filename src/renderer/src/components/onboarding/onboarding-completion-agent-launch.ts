import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { launchAgentInNewTabWithOutcome } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { captureAgentTabLaunchContext } from '@/components/agent-tab-launch-context'
import { activateAndRevealWorkspaceWithOutcome } from '@/lib/worktree-activation'
import { reportAgentWorkspaceActivation } from '@/lib/worktree-activation-outcome'

export function launchOnboardingCompletionAgent(
  worktreeId: string,
  agent: TuiAgent,
  workspaceExecutionHostId?: ExecutionHostId
): void {
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
