import { notifyBlockedAgentStartup } from '@/lib/agent-session/launch/prompt/blocked-agent-startup-notice'
import type { CreateWorktreeArgs } from '../../../../../shared/worktree/create-types'

const startupDrafts = new Map<string, string>()

export async function createLocalWorktreeWithStartupDraft(
  args: CreateWorktreeArgs,
  draft?: string
) {
  const { creationId } = args
  if (!draft || !creationId || args.startup?.launchConfig?.commandProvenance !== 'generated') {
    return window.api.worktrees.create(args)
  }

  // The gate can settle before the create reply, or after the creation UI closes.
  startupDrafts.set(creationId, draft)
  let reportsSetupGateOutcome = false
  try {
    const result = await window.api.worktrees.create(args)
    reportsSetupGateOutcome = result.startupTerminal?.reportsSetupGateOutcome === true
    return result
  } finally {
    if (!reportsSetupGateOutcome) {
      startupDrafts.delete(creationId)
    }
  }
}

export function settleWorktreeCreationSetupGate(creationId: string, blocked: boolean): void {
  const draft = startupDrafts.get(creationId)
  startupDrafts.delete(creationId)
  if (blocked && draft) {
    notifyBlockedAgentStartup('unknown', draft)
  }
}
