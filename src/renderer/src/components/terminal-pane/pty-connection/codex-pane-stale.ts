import { useAppStore } from '@/store'
import { blocksCodexPaneInput } from '../../codex-restart-notice-state'

let codexRestartNoticePresenceSource: Record<
  string,
  { previousAccountLabel: string; nextAccountLabel: string }
> | null = null
let codexRestartNoticePresence = false

export function hasCodexRestartNotices(
  noticesByPtyId: Record<string, { previousAccountLabel: string; nextAccountLabel: string }>
): boolean {
  if (codexRestartNoticePresenceSource !== noticesByPtyId) {
    codexRestartNoticePresenceSource = noticesByPtyId
    codexRestartNoticePresence = Object.keys(noticesByPtyId).length > 0
  }
  return codexRestartNoticePresence
}

export function isCodexPaneStale(args: {
  tabId: string
  worktreeId: string
  panePtyId: string | null
}): boolean {
  const state = useAppStore.getState()
  const { codexRestartNoticeByPtyId } = state
  if (!hasCodexRestartNotices(codexRestartNoticeByPtyId)) {
    return false
  }
  // The bound PTY owns this pane’s input; tab.ptyId may name a sibling whose notice must not block this keyboard.
  if (args.panePtyId) {
    return blocksCodexPaneInput(codexRestartNoticeByPtyId[args.panePtyId])
  }

  // Only unbound panes use the persisted tab ID: transports refuse writes until bound, so input can only arm recovery.
  const tab = (state.tabsByWorktree[args.worktreeId] ?? []).find((entry) => entry.id === args.tabId)
  if (tab?.ptyId && blocksCodexPaneInput(codexRestartNoticeByPtyId[tab.ptyId])) {
    return true
  }

  return false
}
