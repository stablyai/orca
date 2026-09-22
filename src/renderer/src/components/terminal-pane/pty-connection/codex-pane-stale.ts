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
  // Why: a bound pane's own record is the last word — its ptyId is exactly the
  // shell its keystrokes reach. `tab.ptyId` holds one sibling's id, not this
  // pane's, so in a split tab consulting it would kill this pane's keyboard over
  // that sibling's notice, with no prompt on screen once the sibling is answered.
  if (args.panePtyId) {
    return blocksCodexPaneInput(codexRestartNoticeByPtyId[args.panePtyId])
  }

  // Why: only an unbound pane needs the tab's persisted id. Both transports
  // refuse writes while their pty binding is null, so a keystroke here arms
  // recovery — a coarser signal than a bound pane's own record, but the tab's id
  // is the only evidence available of which shell this pane is about to own.
  const tab = (state.tabsByWorktree[args.worktreeId] ?? []).find((entry) => entry.id === args.tabId)
  if (tab?.ptyId && blocksCodexPaneInput(codexRestartNoticeByPtyId[tab.ptyId])) {
    return true
  }

  return false
}
