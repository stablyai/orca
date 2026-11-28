import { useId, useMemo, useState } from 'react'
import { AlertTriangle, Folder, Workflow } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Toggle } from '@/components/ui/toggle'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  DeleteWorktreeChangesFileList,
  deleteWorktreeLossLine
} from './DeleteWorktreeChangesSummary'
import {
  DeleteWorktreeLocalFilesHint,
  getIgnoredFilesLossLabel
} from './DeleteWorktreeLocalFilesHint'
import type {
  DeleteWorktreeChangeCheckState,
  DeleteWorktreeDirtyChangePreview
} from './delete-worktree-dirty-change-counts'
import type { useDeleteWorktreeDirtyChanges } from './use-delete-worktree-dirty-changes'
import type { DeleteWorktreeLocalFilesState } from './use-delete-worktree-at-risk-local-files'

type WorktreeReviewRow = {
  worktree: Worktree
  identity: string
  isParent: boolean
  kept: boolean
  projectLabel: string | undefined
  changeCount: number | undefined
  checkState: DeleteWorktreeChangeCheckState | undefined
  preview: DeleteWorktreeDirtyChangePreview | undefined
  ignored: DeleteWorktreeLocalFilesState | undefined
  unsaved: readonly OpenFile[]
}

export function DeleteWorktreeLineageReview({
  parent,
  descendants,
  repoMap,
  dirtyChanges,
  atRiskLocalFilesByIdentity,
  unsavedFiles,
  keepChildren
}: {
  parent: Worktree
  descendants: readonly Worktree[]
  repoMap: Map<string, Repo>
  dirtyChanges: ReturnType<typeof useDeleteWorktreeDirtyChanges>
  atRiskLocalFilesByIdentity: ReadonlyMap<string, DeleteWorktreeLocalFilesState>
  unsavedFiles: readonly OpenFile[]
  keepChildren: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const detailId = useId()
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null)
  const projects = useAppStore((s) => s.projects)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const projectIndex = useMemo(
    () => buildProjectGroupingIndex({ projects, projectHostSetups }),
    [projects, projectHostSetups]
  )
  const parentGroup = getProjectGroupingForRepo(parent.repoId, repoMap, projectIndex)
  const unsavedByWorkspace = Map.groupBy(unsavedFiles, (file) => file.worktreeId)
  const rows = [parent, ...descendants].map((worktree): WorktreeReviewRow => {
    const identity = getWorktreeHostIdentity(worktree)
    const changeKey = worktree.hostId ? identity : worktree.id
    const isParent = worktree === parent
    const group = getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex)
    return {
      worktree,
      identity,
      isParent,
      kept: !isParent && (keepChildren || worktree.isMainWorktree),
      projectLabel: group.key === parentGroup.key ? undefined : group.label,
      changeCount: dirtyChanges.counts.get(changeKey),
      checkState: dirtyChanges.checkStates.get(changeKey),
      preview: dirtyChanges.previews.get(changeKey),
      ignored: atRiskLocalFilesByIdentity.get(identity),
      unsaved: unsavedByWorkspace.get(worktree.id) ?? []
    }
  })
  const selected = rows.find((row) => row.identity === selectedIdentity) ?? rows[1] ?? rows[0]

  return (
    <div className="grid min-h-24 min-w-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] border-t border-border sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] sm:grid-rows-1">
      <ul
        aria-label={t('worktree.delete.workspacesToReview', 'Workspaces to review')}
        className="scrollbar-sleek min-w-0 space-y-1 overflow-y-auto pt-2 pr-2 pb-2 [scrollbar-gutter:stable]"
      >
        {rows.map((row) => {
          const Icon = row.isParent ? Folder : Workflow
          const ignoredFiles = row.ignored?.status === 'complete' ? row.ignored.files : undefined
          const hasIgnoredFiles = ignoredFiles !== undefined && ignoredFiles.count > 0
          const loss = row.kept
            ? null
            : hasIgnoredFiles && row.changeCount === undefined && row.unsaved.length === 0
              ? getIgnoredFilesLossLabel(ignoredFiles, t)
              : deleteWorktreeLossLine(row.changeCount, row.unsaved.length, t, hasIgnoredFiles)
          const checking = row.checkState === 'checking' || row.ignored?.status === 'checking'
          const status = row.kept
            ? t('worktree.delete.workspaceKept', 'Will be kept')
            : (loss ??
              (checking
                ? t('components.workspace.delete.changes.checking', 'Checking for changes…')
                : row.isParent
                  ? t('worktree.delete.parentWorkspace', 'Parent workspace')
                  : ''))
          return (
            <li key={row.identity} className="min-w-0">
              <Toggle
                variant="segmented"
                pressed={row === selected}
                aria-controls={detailId}
                onPressedChange={(pressed) => {
                  if (pressed) {
                    setSelectedIdentity(row.identity)
                  }
                }}
                className="h-auto w-full min-w-0 cursor-pointer justify-start text-left"
              >
                <span className="flex min-w-0 flex-1 items-start gap-2 py-1.5">
                  <Icon aria-hidden="true" className="mt-0.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5">
                      <span
                        className="truncate font-semibold text-foreground"
                        title={row.worktree.displayName}
                      >
                        {row.worktree.displayName}
                      </span>
                      {row.projectLabel ? (
                        <span
                          className="max-w-1/2 truncate text-xs font-normal text-muted-foreground"
                          title={row.projectLabel}
                        >
                          {row.projectLabel}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'flex h-4 min-w-0 items-center gap-1 text-xs leading-4',
                        loss ? 'text-destructive' : 'font-normal text-muted-foreground'
                      )}
                      title={status || undefined}
                    >
                      {loss ? (
                        <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
                      ) : null}
                      <span className="truncate">{status}</span>
                    </span>
                  </span>
                </span>
              </Toggle>
            </li>
          )
        })}
      </ul>
      <div
        key={selected.identity}
        id={detailId}
        role="region"
        aria-label={t('worktree.delete.workspaceDetails', 'Selected workspace details')}
        tabIndex={0}
        className="scrollbar-sleek min-w-0 space-y-2.5 overflow-y-auto border-t border-border pt-3 pr-2 pb-2 text-xs [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none sm:border-t-0 sm:border-l sm:pl-4"
      >
        <div className="min-w-0">
          <div className="text-[13px] font-semibold wrap-anywhere">
            {selected.worktree.displayName}
          </div>
          <div className="font-mono wrap-anywhere text-muted-foreground">
            {selected.worktree.path}
          </div>
        </div>
        <div className="min-w-0 space-y-2.5" aria-live="polite">
          {selected.kept ? (
            <p className="text-muted-foreground">
              {keepChildren
                ? t(
                    'worktree.delete.childrenPreservedDescription',
                    'Direct children will become top-level workspaces. Their files, terminals, and nested children will be kept.'
                  )
                : t(
                    'auto.components.sidebar.DeleteWorktreeDialog.gitBlocksMainWorktree',
                    'Git does not allow removing the main worktree.'
                  )}
            </p>
          ) : (
            <>
              <DeleteWorktreeReviewChanges row={selected} />
              <DeleteWorktreeLocalFilesHint state={selected.ignored} inline />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DeleteWorktreeReviewChanges({ row }: { row: WorktreeReviewRow }): React.JSX.Element {
  const t = useTranslate()
  const loss = deleteWorktreeLossLine(row.changeCount, row.unsaved.length, t)
  const status =
    row.checkState === 'checking'
      ? t('components.workspace.delete.changes.checking', 'Checking for changes…')
      : row.checkState === 'unavailable'
        ? t('components.workspace.delete.changes.unavailable', 'Changes could not be checked')
        : row.checkState === 'complete' && !loss
          ? t('components.workspace.delete.changes.none', 'No uncommitted changes')
          : null
  return (
    <div className="space-y-1.5 empty:hidden">
      {loss ? (
        <p className="flex items-start gap-1.5 font-medium text-destructive">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <span>{loss}</span>
        </p>
      ) : null}
      {status ? <p className="text-muted-foreground">{status}</p> : null}
      {row.preview?.files.length || row.unsaved.length ? (
        <DeleteWorktreeChangesFileList preview={row.preview} unsavedFiles={row.unsaved} />
      ) : null}
      {row.preview?.files.length ? (
        <p className="text-2xs text-muted-foreground">
          {t(
            'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.loadedPathsNotice',
            'Loaded paths may be incomplete or out of date.'
          )}
        </p>
      ) : null}
    </div>
  )
}

export function DeleteWorktreeKeepChildren({
  checked,
  canKeep,
  childrenChanged,
  disabled,
  onCheckedChange
}: {
  checked: boolean
  canKeep: boolean
  childrenChanged: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const blockerId = useId()
  const blocker = canKeep
    ? null
    : childrenChanged
      ? t(
          'worktree.delete.childrenChangedClearPreserve',
          'Child workspaces changed. Clear this option to review deletion.'
        )
      : t(
          'worktree.delete.nestedChildrenCannotBeKept',
          'Child workspace folders inside this workspace must be moved outside it before they can be kept.'
        )
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={checked}
          disabled={disabled || (!canKeep && !checked)}
          aria-describedby={blocker ? blockerId : undefined}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
        {t('worktree.delete.detachChildren', 'Detach and keep child workspaces')}
      </label>
      {blocker ? (
        <p id={blockerId} className="text-xs text-muted-foreground">
          {blocker}
        </p>
      ) : null}
    </div>
  )
}
