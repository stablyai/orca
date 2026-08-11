/**
 * Detect a stash apply/pop that merged with conflicts. Git exits non-zero, keeps
 * the entry, and leaves the conflicts in the working tree — so this separates
 * "expected conflict outcome" from a real failure.
 *
 * Matching English output is safe because every git subprocess runs under
 * UNTRANSLATED_GIT_OUTPUT_ENV (main) or buildRelayGitEnv (relay).
 */
export function isStashApplyConflictOutput(text: string): boolean {
  return (
    /^CONFLICT \(/m.test(text) ||
    /could not restore untracked files from stash/i.test(text) ||
    /the stash entry is kept in case you need it again/i.test(text)
  )
}

/** True when git rejected the ref itself (bad index, cleared stash list). */
export function isUnknownStashRefOutput(text: string): boolean {
  return (
    /is not a valid reference/i.test(text) ||
    /no stash entries found/i.test(text) ||
    /is not a stash-like commit/i.test(text)
  )
}
