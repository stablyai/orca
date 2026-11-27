import { notifyBlockedAgentStartup } from '@/lib/agent-session/launch/prompt/blocked-agent-startup-notice'
import type { AgentProgramBlockReason } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CreateWorktreeArgs } from '../../../../../shared/worktree/create-types'

const startupPrompts = new Map<string, string>()

export async function createLocalWorktreeWithStartupDraft(
  args: CreateWorktreeArgs,
  prompt?: string
) {
  const { creationId } = args
  if (
    !prompt?.trim() ||
    !creationId ||
    args.startup?.launchConfig?.commandProvenance !== 'generated'
  ) {
    return window.api.worktrees.create(args)
  }

  // The gate can settle before the create reply, or after the creation UI closes.
  startupPrompts.set(creationId, prompt)
  let reportsSetupGateOutcome = false
  try {
    const result = await window.api.worktrees.create(args)
    reportsSetupGateOutcome = result.startupTerminal?.reportsSetupGateOutcome === true
    return result
  } finally {
    if (!reportsSetupGateOutcome) {
      startupPrompts.delete(creationId)
    }
  }
}

export function settleWorktreeCreationSetupGate(
  creationId: string,
  blockReason: AgentProgramBlockReason | undefined
): void {
  const prompt = startupPrompts.get(creationId)
  startupPrompts.delete(creationId)
  if (blockReason && prompt) {
    notifyBlockedAgentStartup(blockReason, { creationId, prompt })
  }
}
