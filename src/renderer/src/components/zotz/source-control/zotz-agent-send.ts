import { useAppStore } from '@/store/index'
import { sendMessageToAgent } from '@/lib/agent-session/messaging/agent-message-send'
import {
  deriveRunningAgentSendTargets,
  runningAgentMessageTarget
} from '@/lib/agent-session/messaging/running-agent-targets'
import { pickZotzFixChecksTarget } from './zotz-pr-fix-checks'

/** Sends a prompt to the conversation's own agent (the active tab's first); 'no-agent' when none can take it. */
export async function sendToZotzConversationAgent(
  worktreeId: string,
  prompt: string
): Promise<'sent' | 'no-agent' | 'failed'> {
  const state = useAppStore.getState()
  const target = pickZotzFixChecksTarget(
    deriveRunningAgentSendTargets(state, worktreeId),
    state.activeTabIdByWorktree?.[worktreeId] ?? null
  )
  if (!target) {
    return 'no-agent'
  }
  const result = await sendMessageToAgent({
    worktreeId,
    target: runningAgentMessageTarget(target),
    prompt
  })
  return result.status === 'sent' || result.status === 'unconfirmed' ? 'sent' : 'failed'
}

/** Conductor's "Create PR": the agent commits, pushes and opens the PR itself. */
export const ZOTZ_CREATE_PR_PROMPT = [
  'Create a pull request for this branch.',
  '1. Commit any pending changes with a clear message.',
  '2. Push the branch.',
  '3. Open the PR against the default branch with `gh pr create`, a concise title and a short summary of what changed and how it was tested.',
  'Reply with the PR link when it is open.'
].join('\n')
