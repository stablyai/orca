/** One side of a Codex restart notice: the account's id when the caller knows
 *  it (`null` is the system default), plus the label shown in the prompt. */
export type CodexRestartNoticeAccount = {
  id?: string | null
  label: string
}

/** Prefer account IDs: distinct ChatGPT workspaces can share email labels, and roster failures collapse labels to a fallback. Compare labels only when neither caller has IDs or real account switches lose prompts. */
export function isSameCodexRestartNoticeAccount(
  a: CodexRestartNoticeAccount,
  b: CodexRestartNoticeAccount
): boolean {
  if (a.id !== undefined && b.id !== undefined) {
    return a.id === b.id
  }
  return a.label === b.label
}
