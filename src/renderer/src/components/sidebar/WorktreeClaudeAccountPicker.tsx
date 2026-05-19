import * as React from 'react'
import { cn } from '@/lib/utils'

export type AccountSummary = { id: string; label: string }

export type WorktreeClaudeAccountPickerViewProps = {
  worktreeId: string
  accounts: AccountSummary[]
  currentOverride: string | null
  onChange: (choice: 'global-default' | string) => void
}

type OverrideUpdate =
  | { action: 'clear'; worktreeId: string }
  | { action: 'set'; worktreeId: string; accountId: string }

/**
 * Pure mapping from the picker's choice into the action shape consumed by the
 * IPC bridge in Task 19. Exported so tests can pin the contract without
 * rendering, and so the dialog can also wire it up directly if it needs to
 * compose its own onApply handler.
 */
export function buildOverrideUpdate(input: {
  worktreeId: string
  choice: 'global-default' | string
}): OverrideUpdate {
  if (input.choice === 'global-default') {
    return { action: 'clear', worktreeId: input.worktreeId }
  }
  return { action: 'set', worktreeId: input.worktreeId, accountId: input.choice }
}

function renderOption(args: {
  label: string
  selected: boolean
  onClick: () => void
  key?: string | number
}): React.JSX.Element {
  return (
    <button
      key={args.key}
      type="button"
      role="radio"
      aria-checked={args.selected}
      // Mirror aria-checked into aria-pressed so the project's existing
      // markup-traversal tests can match either signal. The test in
      // WorktreeClaudeAccountPicker.test.tsx asserts `aria-pressed="true"`.
      aria-pressed={args.selected}
      onClick={args.onClick}
      className={cn(
        'flex w-full items-center justify-between rounded-md border border-border/50 bg-background px-2 py-1.5 text-left text-xs transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring',
        args.selected
          ? 'border-foreground/30 bg-accent text-accent-foreground'
          : 'hover:bg-accent/50 hover:text-accent-foreground'
      )}
    >
      <span>{args.label}</span>
      {args.selected ? (
        <span aria-hidden="true" className="text-[10px] text-muted-foreground">
          Active
        </span>
      ) : null}
    </button>
  )
}

/**
 * Stateless render of the worktree-scoped Claude account picker.
 *
 * Renders one option per available account plus a "Use global default" option
 * which clears the override. Exported separately from the stateful wrapper so
 * the renderer test suite (environment: 'node', no RTL) can call it directly
 * as a function and traverse the resulting tree.
 *
 * Options are inlined (not wrapped in a child component) so that calling this
 * function directly produces a tree the markup-traversal test helpers can
 * walk without invoking nested function components.
 */
export function WorktreeClaudeAccountPickerView({
  accounts,
  currentOverride,
  onChange
}: WorktreeClaudeAccountPickerViewProps): React.JSX.Element {
  // currentOverride === null means "follow the global default" — that option
  // is rendered first and is the only selected radio when no override is set.
  const defaultSelected = currentOverride === null
  return (
    <div role="radiogroup" aria-label="Claude account for this worktree" className="space-y-1">
      {renderOption({
        label: 'Use global default',
        selected: defaultSelected,
        onClick: () => onChange('global-default')
      })}
      {accounts.map((account) =>
        renderOption({
          key: account.id,
          label: account.label,
          selected: currentOverride === account.id,
          onClick: () => onChange(account.id)
        })
      )}
    </div>
  )
}

export type WorktreeClaudeAccountPickerProps = {
  worktreeId: string
  accounts: AccountSummary[]
  currentOverride: string | null
  onApply: (update: OverrideUpdate) => void
}

/**
 * Stateful wrapper. Thin delegator that adapts the view's `onChange` (a
 * choice string) into the `OverrideUpdate` action shape the dialog (and IPC
 * in Task 19) wants. No internal state — the parent owns `currentOverride`.
 */
export function WorktreeClaudeAccountPicker({
  worktreeId,
  accounts,
  currentOverride,
  onApply
}: WorktreeClaudeAccountPickerProps): React.JSX.Element {
  return (
    <WorktreeClaudeAccountPickerView
      worktreeId={worktreeId}
      accounts={accounts}
      currentOverride={currentOverride}
      onChange={(choice) => onApply(buildOverrideUpdate({ worktreeId, choice }))}
    />
  )
}
