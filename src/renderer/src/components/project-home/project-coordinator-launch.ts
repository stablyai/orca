import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { assertProjectHomeCapability } from './project-home-api'

export function coordinatorPrompt(goal: string, instructions: string): string {
  return `Coordinate this project using Orca's orchestration skill. Read that skill before starting. Create a new Run from this terminal for the goal below, plan the work, delegate bounded tasks when useful, and track results and blockers in that Run. Keep implementation, test evidence, review and deployment distinct. Do not claim success without evidence.\n\nGoal:\n${goal}\n\nProject instructions:\n${instructions}`
}

export async function launchProjectCoordinator(args: {
  target: RuntimeClientTarget
  repoId: string
  executionHostId: ExecutionHostId
  signal?: AbortSignal
  worktreeId: string
  agent: TuiAgent
  prompt: string
}): Promise<void> {
  const { target, repoId, worktreeId, agent, prompt } = args
  const proof = await assertProjectHomeCapability(target)
  const state = useAppStore.getState()
  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  const worktree = state.getKnownWorktreeById(worktreeId, hostId)
  const owner = target.kind === 'environment' ? target.environmentId : null
  if (
    args.signal?.aborted ||
    hostId !== args.executionHostId ||
    !worktree ||
    worktree.repoId !== repoId ||
    getRuntimeEnvironmentIdForWorktree(state, worktreeId) !== owner
  ) {
    throw new Error('Workspace ownership changed. Select a workspace again.')
  }
  if (!isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    throw new Error('Enable this agent in Settings first.')
  }
  // Paired hosts apply their own trust preflight; never mark a remote path trusted locally.
  if (target.kind === 'local') {
    await preflightAgentTrust({
      agent,
      workspacePath: worktree.path,
      connectionId: getConnectionIdFromState(state, worktreeId)
    })
  }
  const current = useAppStore.getState()
  if (
    args.signal?.aborted ||
    (target.kind === 'environment' &&
      captureRuntimeEnvironmentRequestRevision(target.environmentId) !==
        proof.expectedEnvironmentPairingRevision) ||
    getExecutionHostIdForWorktree(current, worktreeId) !== args.executionHostId ||
    getRuntimeEnvironmentIdForWorktree(current, worktreeId) !== owner ||
    current.getKnownWorktreeById(worktreeId, hostId)?.repoId !== repoId
  ) {
    throw new Error('Workspace changed during launch.')
  }
  current.setActiveWorktree(worktreeId, hostId)
  const result = launchAgentInNewTab({
    agent,
    worktreeId,
    prompt,
    promptDelivery: 'draft',
    agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
      route: 'terminal-tui',
      agent,
      worktreeId,
      prompt,
      promptDelivery: 'draft'
    })
  })
  if (!result) {
    throw new Error('Could not prepare the coordinator launch.')
  }
  current.setActiveView('terminal')
  if (result.surface.kind === 'local-terminal') {
    focusTerminalTabSurface(result.surface.tabId)
  }
}
