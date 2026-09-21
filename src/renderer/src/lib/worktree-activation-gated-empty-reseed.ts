import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  gateWorktreeAgentActivation,
  type WorktreeAgentActivationOutcome
} from './worktree-agent-activation-gate'
import { reseedGatedEmptyWorkspace } from './worktree-initial-terminal-seeding'

type GatedEmptyWorkspaceReseedIntent = {
  callerProvidesSurface: boolean
  executionHostId?: ExecutionHostId
}

const latestReseedIntentByGate = new WeakMap<
  Promise<WorktreeAgentActivationOutcome>,
  GatedEmptyWorkspaceReseedIntent
>()

export function gateAndReseedEmptyWorkspace(
  workspaceKey: string,
  callerProvidesSurface: boolean,
  executionHostId?: ExecutionHostId
): void {
  const gate = gateWorktreeAgentActivation(workspaceKey)
  const intent: GatedEmptyWorkspaceReseedIntent = {
    callerProvidesSurface,
    ...(executionHostId ? { executionHostId } : {})
  }
  latestReseedIntentByGate.set(gate, intent)
  void gate.then((outcome) => {
    if (latestReseedIntentByGate.get(gate) !== intent) {
      return
    }
    latestReseedIntentByGate.delete(gate)
    if (outcome === 'empty') {
      reseedGatedEmptyWorkspace(workspaceKey, intent.callerProvidesSurface, intent.executionHostId)
    }
  })
}
