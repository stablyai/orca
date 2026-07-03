export type CodexRestartOverlayCollapseState = {
  noticeKey: string | null
  collapsed: boolean
}

export function buildCodexRestartNoticeKey(args: {
  previousAccountLabel: string
  nextAccountLabel: string
}): string {
  return `${args.previousAccountLabel}\u0000${args.nextAccountLabel}`
}

export function getCodexRestartOverlayCollapseState(
  state: CodexRestartOverlayCollapseState,
  noticeKey: string | null
): CodexRestartOverlayCollapseState {
  return state.noticeKey === noticeKey
    ? state
    : {
        noticeKey,
        collapsed: false
      }
}

export function createCodexRestartOverlayCollapseState(
  noticeKey: string | null
): CodexRestartOverlayCollapseState {
  return {
    noticeKey,
    collapsed: false
  }
}
