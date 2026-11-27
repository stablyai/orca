import { notifyBlockedAgentStartup } from '@/lib/agent-session/launch/prompt/blocked-agent-startup-notice'
import { WORKTREE_SETUP_GATE_OBSERVER_TIMEOUT_MS } from '../../../../../shared/agent-launch/startup/setup-wait-output-gate'
import type { AgentProgramBlockReason } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CreateWorktreeArgs } from '../../../../../shared/worktree/create-types'

type StartupPrompt = { prompt: string; expiry?: number }

const startupPrompts = new Map<string, StartupPrompt>()
let unsubscribeSetupGate: (() => void) | undefined

export function installWorktreeCreationSetupGateListener(): void {
  unsubscribeSetupGate ??= window.api.worktrees.onCreateProgress?.((data) => {
    if (data.phase === 'startup-gate-settled' && data.creationId) {
      settleWorktreeCreationSetupGate(data.creationId, data.blockReason)
    }
  })
}

import.meta.hot?.dispose(() => unsubscribeSetupGate?.())

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
  const entry: StartupPrompt = { prompt }
  window.clearTimeout(startupPrompts.get(creationId)?.expiry)
  startupPrompts.set(creationId, entry)
  let reportsSetupGateOutcome = false
  try {
    const result = await window.api.worktrees.create(args)
    reportsSetupGateOutcome = result.startupTerminal?.reportsSetupGateOutcome === true
    return result
  } finally {
    if (startupPrompts.get(creationId) === entry) {
      if (reportsSetupGateOutcome) {
        entry.expiry = window.setTimeout(() => {
          startupPrompts.delete(creationId)
        }, WORKTREE_SETUP_GATE_OBSERVER_TIMEOUT_MS)
      } else {
        startupPrompts.delete(creationId)
      }
    }
  }
}

function settleWorktreeCreationSetupGate(
  creationId: string,
  blockReason: AgentProgramBlockReason | undefined
): void {
  const entry = startupPrompts.get(creationId)
  window.clearTimeout(entry?.expiry)
  startupPrompts.delete(creationId)
  if (blockReason && entry) {
    notifyBlockedAgentStartup(blockReason, { creationId, prompt: entry.prompt })
  }
}
