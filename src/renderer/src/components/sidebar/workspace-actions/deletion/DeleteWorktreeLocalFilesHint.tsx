// @protected-copy
import type { JSX } from 'react'
import { AlertTriangle, ChevronRight, File, Folder } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/removal/at-risk-local-files'
import { hasWorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/removal/at-risk-local-files'
import { DeleteWorktreeRelativePath, isDirectoryDisplayPath } from './delete-worktree-relative-path'
import type { DeleteWorktreeLocalFilesState } from './use-delete-worktree-at-risk-local-files'

export function DeleteWorktreeLocalFilesHint({
  state
}: {
  state: DeleteWorktreeLocalFilesState | undefined
}): JSX.Element | null {
  const t = useTranslate()
  if (!state) {
    return null
  }

  if (state.status !== 'complete' || !hasWorktreeAtRiskLocalFiles(state.files)) {
    const statusLabel =
      state.status === 'complete'
        ? t('components.workspace.delete.ignoredFiles.none', 'No ignored local files')
        : state.status === 'unsupported'
          ? t('components.workspace.delete.ignoredFiles.unavailable', 'Ignored files not checked')
          : t('components.workspace.delete.ignoredFiles.checking', 'Checking ignored files…')
    return (
      <div className="mt-0.5 flex h-4 min-w-0 items-center text-muted-foreground">
        <span className="truncate">{statusLabel}</span>
      </div>
    )
  }

  const { files } = state
  const listedPaths = files.paths ?? files.samplePaths

  if (files.count === 0 || listedPaths.length === 0) {
    const uncheckedLabel = t(
      'components.workspace.delete.ignoredFilesUnchecked',
      'Ignored files could not be fully checked'
    )
    return (
      <div className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-destructive">
        <AlertTriangle className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-medium">{uncheckedLabel}</span>
      </div>
    )
  }

  const countLabel = files.complete
    ? t('components.workspace.delete.ignoredFiles.lost', '{{count}} ignored files will be lost', {
        count: files.count,
        defaultValue_one: '{{count}} ignored file will be lost'
      })
    : t(
        'components.workspace.delete.ignoredFiles.lostIncomplete',
        '{{count}}+ ignored files will be lost',
        { count: files.count }
      )
  const inlinePreview = files.samplePaths.join(', ')

  return (
    <Collapsible className="mt-0.5 min-w-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={`${countLabel}: ${t('components.workspace.delete.ignoredFiles.showPaths', 'Show ignored paths')}`}
          className="group flex h-4 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <AlertTriangle className="size-3 shrink-0 text-destructive" />
          <span className="min-w-0 truncate font-medium text-destructive group-hover:underline">
            {countLabel}
          </span>
          {inlinePreview ? (
            <span className="flex min-w-0 shrink-[9999] items-center gap-1 text-muted-foreground group-data-[state=open]:hidden">
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span className="min-w-0 truncate font-mono text-2xs">{inlinePreview}</span>
            </span>
          ) : null}
          <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-all duration-150 group-hover:text-foreground group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent animation="height">
        <DeleteWorktreeLocalFilesDetails files={files} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function DeleteWorktreeLocalFilesDetails({
  files
}: {
  files: WorktreeAtRiskLocalFiles
}): JSX.Element {
  const t = useTranslate()
  const listedPaths = files.paths ?? files.samplePaths
  const remainingPathCount = Math.max(0, files.count - listedPaths.length)
  const listLabel = t(
    'components.workspace.delete.ignoredFiles.listLabel',
    'Ignored local files that will be lost'
  )
  return (
    <div className="pt-1.5">
      <div
        role="region"
        aria-label={listLabel}
        tabIndex={0}
        className="scrollbar-sleek max-h-40 min-w-0 overflow-y-auto rounded-sm border border-border/60 bg-background/60 px-2.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ul className="min-w-0 space-y-1 font-mono text-xs">
          {listedPaths.map((relativePath) => {
            const EntryIcon = isDirectoryDisplayPath(relativePath) ? Folder : File
            return (
              <li key={relativePath} className="flex min-w-0 items-start gap-2">
                <EntryIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 wrap-anywhere text-foreground">
                  <DeleteWorktreeRelativePath path={relativePath} />
                </span>
              </li>
            )
          })}
        </ul>
        {remainingPathCount > 0 ? (
          <p className="mt-1.5 border-t border-border/50 pt-1 text-2xs text-muted-foreground">
            {t(
              'components.workspace.delete.ignoredFiles.morePaths',
              'and {{count}} more ignored paths',
              {
                count: remainingPathCount,
                defaultValue_one: 'and {{count}} more ignored path'
              }
            )}
          </p>
        ) : null}
        {!files.complete ? (
          <p className="mt-1.5 border-t border-border/50 pt-1 text-2xs text-muted-foreground">
            {t(
              'components.workspace.delete.ignoredFiles.incompleteNotice',
              'Check stopped early; more ignored files in this worktree may also be deleted.'
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
