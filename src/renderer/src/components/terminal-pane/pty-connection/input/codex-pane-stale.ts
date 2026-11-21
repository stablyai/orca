import {
  isCodexAccountRestart,
  isCurrentCodexAccountRestart
} from '@/store/terminals/codex-account-restart-continuation'
import { getTerminalNoticeLifetime } from '../../provider-notices/terminal-notice-lifetime'
import { useAppStore } from '@/store/index'
import { blocksCodexPaneInput } from '../../account-restart/codex-restart-notice-state'

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
  leafId: string
  panePtyId: string | null
  paneIncarnationId?: string | null
}): boolean {
  const state = useAppStore.getState()
  const { codexRestartNoticeByPtyId } = state
  const panePtyId =
    args.panePtyId ??
    state.terminalLayoutsByTabId[args.tabId]?.ptyIdsByLeafId?.[args.leafId] ??
    null
  const paneIncarnationId = args.panePtyId
    ? args.paneIncarnationId
    : panePtyId
      ? getTerminalNoticeLifetime(panePtyId)?.incarnationId
      : null
  if (panePtyId) {
    const request =
      state.pendingPaneAccountRestarts[`${args.tabId}:${args.leafId}`] ??
      state.pendingPaneAccountRestarts[`${args.tabId}:unresolved`]
    const expectedIncarnation = isCodexAccountRestart(request)
      ? (request.oldIncarnationId ??
        (request.condition?.expected.kind === 'endpoint'
          ? request.condition.expected.incarnationId
          : undefined))
      : undefined
    if (
      isCodexAccountRestart(request) &&
      request.oldPtyId === panePtyId &&
      request.worktreeId === args.worktreeId &&
      (!paneIncarnationId || !expectedIncarnation || paneIncarnationId === expectedIncarnation) &&
      isCurrentCodexAccountRestart(state, request)
    ) {
      return true
    }
  }
  if (!hasCodexRestartNotices(codexRestartNoticeByPtyId)) {
    return false
  }
  // The bound PTY owns this pane’s input; tab.ptyId may name a sibling whose notice must not block this keyboard.
  if (panePtyId) {
    const notice = codexRestartNoticeByPtyId[panePtyId]
    return (
      blocksCodexPaneInput(notice) &&
      (!paneIncarnationId || !notice?.incarnationId || notice.incarnationId === paneIncarnationId)
    )
  }

  return false
}
