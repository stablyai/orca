import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activeAgentNotesSendFailureMessage } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'
import { addQuoteToAgent } from './native-chat-workspace-selection'
import { lastUsedAgentTarget } from './last-used-agent-target'

/** Puts the quote, unsent, where the project's last used agent takes input; no agent, no-op. */
export function addQuoteToLastUsedAgent(worktreeId: string, quote: string): void {
  const state = useAppStore.getState()
  const last = lastUsedAgentTarget(state, worktreeId)
  if (!last) {
    return
  }
  if (
    last.worktreeId !== state.activeWorktreeId &&
    activateAndRevealWorkspace(last.worktreeId) === false
  ) {
    return
  }
  void addQuoteToAgent(last.worktreeId, last.target, quote).then((result) => {
    if (result.status !== 'sent') {
      toast.info(
        activeAgentNotesSendFailureMessage(result.status, {
          explicitTarget: true,
          subject: 'selection'
        })
      )
    }
  })
}
