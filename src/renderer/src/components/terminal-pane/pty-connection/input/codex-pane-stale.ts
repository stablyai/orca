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
  leafId: string
  panePtyId: string | null
  paneIncarnationId?: string | null
}): boolean {
  const state = useAppStore.getState()
  const { codexRestartNoticeByPtyId } = state
  if (args.panePtyId) {
    const request =
      state.paneAccountRestarts[`${args.tabId}:${args.leafId}`] ??
      state.paneAccountRestarts[`${args.tabId}:unresolved`]
    const expectedIncarnation = isCodexAccountRestart(request)
      ? (request.oldIncarnationId ??
        (request.condition?.expected.kind === 'endpoint'
          ? request.condition.expected.incarnationId
          : undefined))
      : undefined
    if (
      isCodexAccountRestart(request) &&
      request.oldPtyId === args.panePtyId &&
      request.worktreeId === args.worktreeId &&
      (!args.paneIncarnationId ||
        !expectedIncarnation ||
        args.paneIncarnationId === expectedIncarnation) &&
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
    const notice = codexRestartNoticeByPtyId[args.panePtyId]
    return (
      blocksCodexPaneInput(notice) &&
      (!args.paneIncarnationId ||
        !notice?.incarnationId ||
        notice.incarnationId === args.paneIncarnationId)
    )
  }

  return false
}
