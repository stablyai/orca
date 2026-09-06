import type { ActivateAndRevealResult } from '@/lib/worktree-activation'

export function finalizeFullCreation(args: {
  setSidebarOpen: (open: boolean) => void
  persistDraft: boolean
  clearNewWorkspaceDraft: () => void
  onCreated?: () => void
  structuredLaunchAccepted: boolean
  worktreeId: string
  activation: ActivateAndRevealResult | false
  queueWorkspaceActivationTerminalFocus: (
    worktreeId: string,
    activation: ActivateAndRevealResult | false
  ) => void
}): void {
  args.setSidebarOpen(true)
  if (args.persistDraft) {
    args.clearNewWorkspaceDraft()
  }
  args.onCreated?.()
  if (!args.structuredLaunchAccepted) {
    args.queueWorkspaceActivationTerminalFocus(args.worktreeId, args.activation)
  }
}
