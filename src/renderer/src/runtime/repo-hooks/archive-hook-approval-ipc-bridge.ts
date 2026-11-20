import { useAppStore } from '@/store'
import { answerArchiveHookApproval } from './archive-hook-approval-answer'

export function registerArchiveHookApprovalIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onArchiveHookApprovalRequest(({ requestId, ...request }) => {
      // Main holds the caller's RPC open until this reply, so a throw must still answer.
      void answerArchiveHookApproval(useAppStore.getState(), request)
        .catch(() => ({ decision: 'undecided' as const }))
        .then((approval) => window.api.ui.replyArchiveHookApproval({ requestId, ...approval }))
    })
  )
}
