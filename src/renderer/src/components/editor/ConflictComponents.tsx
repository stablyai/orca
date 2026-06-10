import React from 'react'
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  GitMerge,
  PanelLeftOpen,
  RefreshCw,
  TriangleAlert,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ConflictReviewEntry, OpenFile } from '@/store/slices/editor'
import type { GitConflictKind, GitStatusEntry } from '../../../../shared/types'
import { ConflictReviewFileTree } from './ConflictReviewFileTree'
import { translate } from '@/i18n/i18n'

export const CONFLICT_KIND_LABELS: Record<GitConflictKind, string> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  both_deleted: 'Both deleted'
}

export const CONFLICT_HINT_MAP: Record<GitConflictKind, string> = {
  both_modified: 'Resolve the conflict markers',
  both_added: 'Choose which version to keep, or combine them',
  deleted_by_us: 'Decide whether to restore the file',
  deleted_by_them: 'Decide whether to keep the file or accept deletion',
  added_by_us: 'Review whether to keep the added file',
  added_by_them: 'Review the added file before keeping it',
  both_deleted: 'Resolve in Git or restore one side before editing'
}

const EMPTY_CONFLICT_REVIEW_ENTRIES: readonly ConflictReviewEntry[] = []
let conflictReviewFileTreeCollapsedPreference = false
type ConflictNavigationDirection = 'previous' | 'next'
type ConflictReviewPanelEntry = ConflictReviewEntry & {
  liveEntry?: GitStatusEntry
}

export function getNextConflictNavigationIndex({
  currentIndex,
  direction,
  total
}: {
  currentIndex: number | null
  direction: ConflictNavigationDirection
  total: number
}): number | null {
  if (total <= 0) {
    return null
  }
  if (currentIndex === null || currentIndex < 0 || currentIndex >= total) {
    return direction === 'previous' ? total - 1 : 0
  }
  return direction === 'previous' ? (currentIndex + total - 1) % total : (currentIndex + 1) % total
}

export function ConflictBanner({
  file,
  entry,
  conflictNavigation
}: {
  file: OpenFile
  entry: GitStatusEntry | null
  conflictNavigation?: {
    currentIndex: number | null
    total: number
    onJump: (direction: ConflictNavigationDirection) => void
  }
}): React.JSX.Element | null {
  const conflict = file.conflict
  if (!conflict) {
    return null
  }

  const isUnresolved = conflict.conflictStatus === 'unresolved'
  const label = isUnresolved ? 'Unresolved' : 'Resolved locally'

  return (
    <div
      className={cn(
        'border-b px-4 py-2 text-xs',
        isUnresolved
          ? 'border-destructive/20 bg-destructive/5'
          : 'border-emerald-500/20 bg-emerald-500/5'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {isUnresolved ? (
            <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          )}
          <span className="min-w-0 truncate font-medium text-foreground">
            {label} {translate("auto.components.editor.ConflictComponents.55d61a0ccd", "conflict ·")}{CONFLICT_KIND_LABELS[conflict.conflictKind]}
          </span>
          {conflictNavigation && conflictNavigation.total > 0 && (
            <span className="shrink-0 px-1 text-[11px] tabular-nums text-muted-foreground">
              {(conflictNavigation.currentIndex ?? 0) + 1} / {conflictNavigation.total}
            </span>
          )}
        </div>
        {conflictNavigation && conflictNavigation.total > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate("auto.components.editor.ConflictComponents.41d9af2e7a", "Previous conflict")}
                  onClick={() => conflictNavigation.onJump('previous')}
                >
                  <ChevronUp className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate("auto.components.editor.ConflictComponents.41d9af2e7a", "Previous conflict")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate("auto.components.editor.ConflictComponents.9c2901ef8a", "Next conflict")}
                  onClick={() => conflictNavigation.onJump('next')}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate("auto.components.editor.ConflictComponents.9c2901ef8a", "Next conflict")}</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
      {/* Why: the hint is omitted here because the file is already open in the
         editor below. Showing "Open and edit…" or similar would be confusing
         when the user is already viewing/editing the working-tree contents.
         The hint is still shown in ConflictPlaceholderView and the review
         list where it provides actionable guidance. */}
      {!isUnresolved && (
        <div className="mt-1 text-muted-foreground">
          {translate("auto.components.editor.ConflictComponents.6e459867ad", "Session-local continuity state. Git is no longer reporting this file as unmerged.")}</div>
      )}
      {entry?.oldPath && (
        <div className="mt-1 text-muted-foreground">{translate("auto.components.editor.ConflictComponents.d5edd81755", "Renamed from")}{entry.oldPath}</div>
      )}
    </div>
  )
}

export function ConflictPlaceholderView({ file }: { file: OpenFile }): React.JSX.Element | null {
  const conflict = file.conflict
  if (!conflict) {
    return null
  }

  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-md space-y-2">
        <div className="text-sm font-medium text-foreground">
          {CONFLICT_KIND_LABELS[conflict.conflictKind]}
        </div>
        <div className="text-xs text-muted-foreground">
          {conflict.message ?? translate("auto.components.editor.ConflictComponents.da539359b6", "No working-tree file is available to edit for this conflict.")}
        </div>
        <div className="text-xs text-muted-foreground">
          {conflict.guidance ?? CONFLICT_HINT_MAP[conflict.conflictKind]}
        </div>
      </div>
    </div>
  )
}

export function ConflictReviewPanel({
  file,
  liveEntries,
  onOpenEntry,
  selectedFile,
  selectedContent,
  onDismiss,
  onRefreshSnapshot,
  onReturnToSourceControl
}: {
  file: OpenFile
  liveEntries: GitStatusEntry[]
  onOpenEntry: (entry: GitStatusEntry) => void
  selectedFile: OpenFile | null
  selectedContent: React.ReactNode
  onDismiss: () => void
  onRefreshSnapshot: () => void
  onReturnToSourceControl: () => void
}): React.JSX.Element {
  const [fileTreeCollapsed, setFileTreeCollapsedState] = React.useState(
    () => conflictReviewFileTreeCollapsedPreference
  )
  const snapshotEntries = file.conflictReview?.entries ?? EMPTY_CONFLICT_REVIEW_ENTRIES
  const liveEntriesByPath = React.useMemo(
    () => new Map(liveEntries.map((entry) => [entry.path, entry])),
    [liveEntries]
  )
  const treeEntries = React.useMemo<readonly ConflictReviewPanelEntry[]>(
    () =>
      snapshotEntries.map((entry) => ({
        ...entry,
        liveEntry: liveEntriesByPath.get(entry.path)
      })),
    [liveEntriesByPath, snapshotEntries]
  )
  const unresolvedSnapshotEntries = treeEntries.filter(
    (entry) => entry.liveEntry?.conflictStatus === 'unresolved'
  )
  const unresolvedCount = unresolvedSnapshotEntries.length
  const snapshotTime = new Date(
    file.conflictReview?.snapshotTimestamp ?? Date.now()
  ).toLocaleTimeString()
  const setFileTreeCollapsed = React.useCallback((collapsed: boolean) => {
    conflictReviewFileTreeCollapsedPreference = collapsed
    setFileTreeCollapsedState(collapsed)
  }, [])

  if (snapshotEntries.length > 0 && unresolvedCount === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-md space-y-3">
          <div className="text-sm font-medium text-foreground">{translate("auto.components.editor.ConflictComponents.992145ff5a", "All conflicts resolved")}</div>
          <div className="text-xs text-muted-foreground">
            {translate("auto.components.editor.ConflictComponents.31931dec46", "This review snapshot no longer has any live unresolved conflicts.")}</div>
          <div className="flex items-center justify-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onReturnToSourceControl}>
              <GitMerge className="size-3.5" />
              {translate("auto.components.editor.ConflictComponents.28e7db4a90", "Source Control")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
              <X className="size-3.5" />
              {translate("auto.components.editor.ConflictComponents.58ad5ad431", "Dismiss")}</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <ConflictReviewFileTree
        entries={treeEntries}
        collapsed={fileTreeCollapsed}
        onCollapsedChange={setFileTreeCollapsed}
        selectedPath={selectedFile?.relativePath ?? null}
        onOpenEntry={onOpenEntry}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-2">
            {fileTreeCollapsed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate("auto.components.editor.ConflictComponents.c8ca989aea", "Show file tree")}
                    onClick={() => setFileTreeCollapsed(false)}
                  >
                    <PanelLeftOpen className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate("auto.components.editor.ConflictComponents.c8ca989aea", "Show file tree")}</TooltipContent>
              </Tooltip>
            )}
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="text-sm font-medium text-foreground">
                {unresolvedCount} {translate("auto.components.editor.ConflictComponents.4be41eaafc", "unresolved conflict")}{unresolvedCount === 1 ? '' : 's'}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-xs text-muted-foreground">
                {translate("auto.components.editor.ConflictComponents.a1ce36f77d", "Snapshot captured at")}{snapshotTime}.
              </span>
            </div>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onRefreshSnapshot}>
            <RefreshCw className="size-3.5" />
            {translate("auto.components.editor.ConflictComponents.90d576adb2", "Refresh")}</Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {selectedContent ?? (
            <div className="flex h-full min-h-0 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {translate("auto.components.editor.ConflictComponents.f338288514", "Loading conflict contents...")}</div>
          )}
        </div>
      </div>
    </div>
  )
}
