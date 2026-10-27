// Keep row types independent so consumers do not import the full resolver state machine.

import type { SourceControlPrimaryActionDecisionInputs } from './source-control-primary-action-decision-types'
import type { GitConflictOperation } from './git-status-types'

export type DropdownActionInputs = SourceControlPrimaryActionDecisionInputs & {
  conflictOperation?: GitConflictOperation
  isPullRequestOperationActive?: boolean
  rebaseBaseRef?: string | null
}

export type DropdownActionKind =
  | 'commit'
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

export type DropdownSeparator = { kind: 'separator'; id: string }

export type DropdownEntry = DropdownItem | DropdownSeparator
