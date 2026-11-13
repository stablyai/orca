import {
  isCodexAccountRestart,
  isCurrentCodexAccountRestart
} from '@/store/terminals/codex-account-restart-continuation'
import { useAppStore } from '@/store/index'
import { blocksCodexPaneInput } from '../../../codex-restart-notice-state'

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
  if (args.panePtyId) {
    const layout = state.terminalLayoutsByTabId[args.tabId]
    const leafId = Object.keys(layout?.ptyIdsByLeafId ?? {}).find(
      (leaf) => layout.ptyIdsByLeafId?.[leaf] === args.panePtyId
    )
    const request = leafId ? state.paneAccountRestarts[`${args.tabId}:${leafId}`] : undefined
    if (
      isCodexAccountRestart(request) &&
      request.oldPtyId === args.panePtyId &&
      isCurrentCodexAccountRestart(state, request)
    ) {
      return true
    }
  }
  if (!hasCodexRestartNotices(codexRestartNoticeByPtyId)) {
    return false
  }
  // The bound PTY owns this pane’s input; tab.ptyId may name a sibling whose notice must not block this keyboard.
  if (args.panePtyId) {
    return blocksCodexPaneInput(codexRestartNoticeByPtyId[args.panePtyId])
  }

  return false
}
