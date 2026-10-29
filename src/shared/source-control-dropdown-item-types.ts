// Keep row types independent so consumers do not import the full resolver state machine.

import type { SourceControlPrimaryActionDecisionInputs } from './source-control-primary-action-decision-types'
import type { GitConflictOperation } from './git-status-types'

export type DropdownActionInputs = SourceControlPrimaryActionDecisionInputs & {
  conflictOperation?: GitConflictOperation
  isPullRequestOperationActive?: boolean
  rebaseBaseRef?: string | null
  // Why: git commit --amend fails while HEAD is unborn, so amend needs a signal Commit does not.
  hasAmendableHead?: boolean
}

export type DropdownActionKind =
  | 'commit'
  | 'commit_amend'
  | 'commit_push'
  | 'commit_sync'
  | 'abort_merge'
  | 'abort_rebase'
  | 'create_pr'
  | 'push_create_pr'
  | 'push'
  | 'force_push'
  | 'pull'
  | 'fast_forward'
  | 'sync'
  | 'rebase_base'
  | 'fetch'
  | 'publish'

export type DropdownItem = {
  kind: DropdownActionKind
  label: string
  title: string
  disabled: boolean
  hint?: string
  variant?: 'default' | 'destructive'
}

// Shared context computes English reasons; each client's copy object translates them for display.
export type AmendDisabledReason =
  | 'Create an initial commit before amending'
  | 'Resolve conflicts before amending'
  | 'Enter a message or stage changes to amend'

export type DropdownSeparator = { kind: 'separator'; id: string }

export type DropdownEntry = DropdownItem | DropdownSeparator
