import * as React from 'react'
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel
} from '@/components/ui/dropdown-menu'

// Why: P2 T20 — per-tab override is intentionally worktree-scoped (every PTY
// in the worktree shares the override). The "for new terminals here" wording
// matches the P1 toast and signals that existing terminals keep their previous
// selection until restarted.

export type AccountSummary = { id: string; label: string }

/** Maps the radio-group sentinel back to a discriminated action. The
 *  "use-default" value clears the override (resolver falls back to the
 *  global active account); any other value is treated as a concrete
 *  account id. */
export function buildPerTabOverrideSubmit(input: {
  worktreeId: string
  choice: 'use-default' | string
}): { action: 'clear'; worktreeId: string } | { action: 'set'; worktreeId: string; accountId: string } {
  if (input.choice === 'use-default') {
    return { action: 'clear', worktreeId: input.worktreeId }
  }
  return { action: 'set', worktreeId: input.worktreeId, accountId: input.choice }
}

export type SortableTabClaudeAccountItemViewProps = {
  worktreeId: string
  accounts: AccountSummary[]
  currentOverride: string | null
  onChange: (choice: 'use-default' | string) => void
}

/** Stateless submenu render. Exported so tests can render it via
 *  `renderToStaticMarkup` without needing the parent dropdown context. */
export function SortableTabClaudeAccountItemView(
  props: SortableTabClaudeAccountItemViewProps
): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Use account for new terminals here…</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Applies to new terminals here. Existing terminals keep their previous account.
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={props.currentOverride ?? 'use-default'}
          onValueChange={(v) => props.onChange(v as 'use-default' | string)}
        >
          <DropdownMenuRadioItem value="use-default">Use workspace default</DropdownMenuRadioItem>
          {props.accounts.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id}>
              {a.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export type SortableTabClaudeAccountItemProps = {
  worktreeId: string
  accounts: AccountSummary[]
  currentOverride: string | null
  onApply: (u: ReturnType<typeof buildPerTabOverrideSubmit>) => void
}

/** Stateful wrapper. Translates the radio-group sentinel into a clear/set
 *  action and forwards it to the parent (which calls the IPC). */
export function SortableTabClaudeAccountItem(
  props: SortableTabClaudeAccountItemProps
): React.JSX.Element {
  return (
    <SortableTabClaudeAccountItemView
      worktreeId={props.worktreeId}
      accounts={props.accounts}
      currentOverride={props.currentOverride}
      onChange={(choice) =>
        props.onApply(buildPerTabOverrideSubmit({ worktreeId: props.worktreeId, choice }))
      }
    />
  )
}
