/** One side of a Codex restart notice: the account's id when the caller knows
 *  it (`null` is the system default), plus the label shown in the prompt. */
export type CodexRestartNoticeAccount = {
  id?: string | null
  label: string
}

/**
 * Decides whether two restart-notice accounts are the same account.
 *
 * Why not the labels: an account label is an email, and nothing stops two
 * accounts from sharing one — the same OpenAI login added under two ChatGPT
 * workspaces, or a failed roster read collapsing every account to the same
 * fallback string. Deciding on labels there erases a prompt for a pane that is
 * genuinely running on the account the user switched away from. Labels remain
 * the fallback only for callers that carry no ids at all.
 */
export function isSameCodexRestartNoticeAccount(
  a: CodexRestartNoticeAccount,
  b: CodexRestartNoticeAccount
): boolean {
  if (a.id !== undefined && b.id !== undefined) {
    return a.id === b.id
  }
  return a.label === b.label
}
