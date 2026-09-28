import { readGitCommandFailureText } from '../git-command-failure-text'

// Why: `git worktree remove` (non-force) categorically refuses any worktree
// containing an initialised submodule, even when parent and submodule are
// fully clean (validate_no_submodules, Git >= 2.17). Callers re-prove
// cleanliness and retry with --force. Both the local runner and the relay pin
// English git output (UNTRANSLATED_GIT_OUTPUT_ENV), so text matching is stable.
export function isSubmoduleWorktreeRemovalRefusal(error: unknown): boolean {
  return /working trees containing submodules cannot be moved or removed/i.test(
    readGitCommandFailureText(error)
  )
}
