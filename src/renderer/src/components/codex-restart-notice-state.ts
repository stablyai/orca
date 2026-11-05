type CodexRestartNoticeState = { restartRequested?: true; dismissed?: true } | null | undefined

/** Block input until a requested restart actually switches accounts; dismissal explicitly accepts keeping the current account. */
export function blocksCodexPaneInput(notice: CodexRestartNoticeState): boolean {
  return Boolean(notice) && !notice?.dismissed
}

export function awaitsCodexRestartAnswer(notice: CodexRestartNoticeState): boolean {
  return Boolean(notice) && !notice?.dismissed && !notice?.restartRequested
}
