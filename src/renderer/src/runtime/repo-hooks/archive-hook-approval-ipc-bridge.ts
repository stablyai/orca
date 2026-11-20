import { useAppStore } from '@/store'
import { answerArchiveHookApproval } from './archive-hook-approval-answer'

export function registerArchiveHookApprovalIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onArchiveHookApprovalRequest(({ requestId, ...request }) => {
      const state = useAppStore.getState()
      // Before trust and the repo catalog load, an approval could read as missing or unambiguous.
      if (!state.persistedUIReady || !state.workspaceSessionReady) {
        window.api.ui.replyArchiveHookApproval({ requestId, decision: 'undecided' })
        return
      }
      // Main holds the caller's RPC open until this reply, so a throw must still answer.
      void answerArchiveHookApproval(state, request)
        .catch(() => ({ decision: 'undecided' as const }))
        .then((approval) => window.api.ui.replyArchiveHookApproval({ requestId, ...approval }))
    })
  )
}
