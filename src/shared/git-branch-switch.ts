// src/shared/git-branch-switch.ts

export type SwitchBranchMode = 'plain' | 'stash' | 'create'

export type SwitchBranchResult =
  | { ok: true }
  | { ok: false; reason: 'dirty_conflict' }
  | { ok: false; reason: 'stash_pop_conflict' }
  | { ok: false; reason: 'failed'; message: string }

export type SwitchBranchOptions = {
  branch: string
  mode: SwitchBranchMode
}

// Why: label the auto-stash so a user inspecting `git stash list` after a
// pop-conflict can recognize Orca created it during a branch switch.
export const SWITCH_BRANCH_STASH_LABEL = 'orca: auto-stash before branch switch'
