// Why: the dropdown's shape is consumed by CommitArea, the composer and the action dispatcher, so it
// lives apart from the resolver — importers of the row union should not pull in the whole state machine.

import type { PrimaryActionInputs } from './source-control-primary-action'
import type { GitConflictOperation } from '../../../../shared/git-status-types'

export type DropdownActionInputs = PrimaryActionInputs & {
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
