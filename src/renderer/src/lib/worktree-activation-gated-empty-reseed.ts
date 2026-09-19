import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import {
  gateWorktreeAgentActivation,
  type WorktreeAgentActivationOutcome
} from './worktree-agent-activation-gate'
import { reseedGatedEmptyWorkspace } from './worktree-initial-terminal-seeding'

type GatedEmptyWorkspaceReseedIntent = {
  callerProvidesSurface: boolean
  executionHostId?: ExecutionHostId
  seedStartupIfEmpty?: WorktreeStartupPayload
}

const latestReseedIntentByGate = new WeakMap<
  Promise<WorktreeAgentActivationOutcome>,
  GatedEmptyWorkspaceReseedIntent
>()

export function gateAndReseedEmptyWorkspace(
  workspaceKey: string,
  callerProvidesSurface: boolean,
  executionHostId?: ExecutionHostId,
  seedStartupIfEmpty?: WorktreeStartupPayload
): void {
  const gate = gateWorktreeAgentActivation(workspaceKey)
  const intent: GatedEmptyWorkspaceReseedIntent = {
    callerProvidesSurface,
    ...(executionHostId ? { executionHostId } : {}),
    ...(seedStartupIfEmpty ? { seedStartupIfEmpty } : {})
  }
  latestReseedIntentByGate.set(gate, intent)
  void gate.then((outcome) => {
    if (latestReseedIntentByGate.get(gate) !== intent) {
      return
    }
    latestReseedIntentByGate.delete(gate)
    if (outcome === 'empty') {
      reseedGatedEmptyWorkspace(
        workspaceKey,
        intent.callerProvidesSurface,
        intent.executionHostId,
        intent.seedStartupIfEmpty
      )
    }
  })
}
