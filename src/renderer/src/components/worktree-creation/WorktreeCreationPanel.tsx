import React from 'react'
import { AlertTriangle, GitBranch, Loader2, RotateCcw, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { retryBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import { getCreationProgressLabel } from '@/lib/pending-worktree-creation'
import { translate } from '@/i18n/i18n'

/**
 * In-frame creation state, shown in the workspace content area while a worktree
 * is being created. Presented as a faux tab: a tab strip carrying the new
 * worktree's name (the title) over a body that holds the live status. This lets
 * the in-progress create read as a real workspace tab whose content is loading,
 * so the handoff to the real terminal is a same-frame swap — and the title
 * (name) and the body status never duplicate each other. Its appearance is
 * debounced upstream so fast creates never paint it.
 */
export default function WorktreeCreationPanel({
  creationId,
  reserveCollapsedSidebarHeaderSpace = false
}: {
  creationId: string
  reserveCollapsedSidebarHeaderSpace?: boolean
}): React.JSX.Element | null {
  const entry = useAppStore((s) => s.pendingWorktreeCreations[creationId])
  if (!entry) {
    return null
  }

  const dismiss = (): void => useAppStore.getState().removePendingWorktreeCreation(creationId)
  const isError = entry.status === 'error'
  const title = entry.request.displayName || entry.request.name

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {/* Faux tab strip: mirrors the real tab row (height, border, bg) so the
          create reads as a workspace tab. Carries only the worktree name + a
          cancel control — the live status lives in the body below. */}
      <div className="flex h-[36px] shrink-0 items-stretch border-b border-border bg-card">
        {reserveCollapsedSidebarHeaderSpace ? (
          // Why: collapsed sidebar chrome floats above this strip, so reserve
          // the same measured width real tabs use to keep title/cancel clear.
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
            // Why: a static worktree glyph (not a spinner) keeps the tab reading
            // as a normal tab; the single loading spinner lives in the body.
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
            onClick={dismiss}
            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* Body: a quiet top-left annotation on the surface the terminal will
          fill — the same spot terminal output appears — so creation → terminal
          reads as one frame filling in. */}
      <div className="min-h-0 flex-1 p-3">
        {isError ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-destructive">
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.ed2a664f8b',
                'Couldn’t create worktree'
              )}
            </span>
            <span className="text-muted-foreground">
              {entry.error ??
                translate(
                  'auto.components.worktree.creation.WorktreeCreationPanel.767951265d',
                  'Something went wrong while creating the worktree.'
                )}
            </span>
            <button
              type="button"
              onClick={() => retryBackgroundWorktreeCreation(creationId)}
              className="inline-flex items-center gap-1 text-foreground hover:underline"
            >
              <RotateCcw className="size-3" />
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.34dd5ee38b',
                'Retry'
              )}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.dabd226118',
                'Dismiss'
              )}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span>{getCreationProgressLabel(entry)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
