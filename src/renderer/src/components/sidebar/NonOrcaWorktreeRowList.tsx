import React from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NonOrcaWorktreeRow } from './non-orca-worktree-visibility-candidates'

type NonOrcaWorktreeRowListProps = {
  rows: readonly NonOrcaWorktreeRow[]
  busyPath: string | null
  pending: boolean
  onToggleVisibility: (row: NonOrcaWorktreeRow) => void
}

export default function NonOrcaWorktreeRowList({
  rows,
  busyPath,
  pending,
  onToggleVisibility
}: NonOrcaWorktreeRowListProps): React.JSX.Element {
  return (
    <ul className="scrollbar-sleek max-h-52 min-w-0 divide-y divide-border overflow-y-auto">
      {rows.map((row) => (
        <li key={row.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{row.displayName}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {row.displayPath}
            </div>
          </div>
          {/* Why: fixed slot keeps the row from resizing when the spinner appears. */}
          <span className="inline-grid size-4 shrink-0 place-items-center">
            {busyPath === row.path ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : null}
          </span>
          <Button
            type="button"
            variant={row.visible ? 'ghost' : 'outline'}
            size="sm"
            disabled={pending}
            aria-label={
              row.visible
                ? translate(
                    'auto.components.sidebar.NonOrcaWorktreeRowList.7d4b1e9c25',
                    'Hide {{value0}} from the sidebar',
                    { value0: row.displayName }
                  )
                : translate(
                    'auto.components.sidebar.NonOrcaWorktreeRowList.8e5c2f0d36',
                    'Show {{value0}} in the sidebar',
                    { value0: row.displayName }
                  )
            }
            onClick={() => onToggleVisibility(row)}
          >
            {row.visible
              ? translate('auto.components.sidebar.NonOrcaWorktreeRowList.9f6d3a1e47', 'Hide')
              : translate('auto.components.sidebar.NonOrcaWorktreeRowList.a07e4b2f58', 'Show')}
          </Button>
        </li>
      ))}
    </ul>
  )
}
