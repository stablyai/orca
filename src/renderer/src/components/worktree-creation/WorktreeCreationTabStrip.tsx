import React from 'react'
import { AlertTriangle, GitBranch, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/** Match real tab chrome for same-frame creation handoff; name/cancel live here, status in the body. */
export default function WorktreeCreationTabStrip({
  title,
  isError,
  reserveCollapsedSidebarHeaderSpace,
  onCancel
}: {
  title: string
  isError: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-[36px] shrink-0 items-stretch border-b border-border bg-card">
      {reserveCollapsedSidebarHeaderSpace ? (
        // Reserve the real tab strip’s measured collapsed-sidebar width so title/cancel remain unobstructed.
        <div
          className="shrink-0"
          style={
            {
              width: 'var(--collapsed-sidebar-header-width)',
              WebkitAppRegion: 'no-drag'
            } as React.CSSProperties
          }
        />
      ) : null}
      <div className="flex h-full max-w-[240px] items-center gap-1.5 border-r border-border px-2.5 text-xs">
        {isError ? (
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          // Keep the tab glyph static; the body owns the single loading spinner.
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-medium text-foreground">{title}</span>
        <button
          type="button"
          title={translate(
            'auto.components.worktree.creation.WorktreeCreationPanel.532aea14ce',
            'Cancel'
          )}
          aria-label={translate(
            'auto.components.worktree.creation.WorktreeCreationPanel.a3346fc6ed',
            'Cancel worktree creation'
          )}
          onClick={onCancel}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  )
}
