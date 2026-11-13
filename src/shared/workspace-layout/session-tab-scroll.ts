/** A scroll of one visible session tab: a terminal pane (by leaf) or a chat transcript. */
export type SessionTabScrollTarget = {
  worktreeId: string
  tabId: string
  leafId: string | null
  /** CSS pixels; positive scrolls toward the latest output. */
  deltaY: number
}

export type SessionTabScrollRequest = SessionTabScrollTarget & { requestId: string }

/** `scrolled` is false when the tab is not on screen in this window. */
export type SessionTabScrollReply = { requestId: string; scrolled: boolean }
