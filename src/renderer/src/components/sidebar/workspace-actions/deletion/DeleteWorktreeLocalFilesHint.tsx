// @protected-copy
import type { JSX } from 'react'
import { AlertTriangle, ChevronRight, File, Folder } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
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
  const remainingPathCount = Math.max(0, files.count - listedPaths.length)
  const popoverTitle = t(
    'components.workspace.delete.ignoredFiles.popoverTitle',
    'Ignored local files'
  )

  return (
    <div className="mt-0.5 flex h-4 min-w-0 items-center">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${countLabel}: ${t('components.workspace.delete.ignoredFiles.showPaths', 'Show ignored paths')}`}
            className="group flex h-4 w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-left text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <AlertTriangle className="size-3 shrink-0" />
            <span className="min-w-0 truncate font-medium group-hover:underline">{countLabel}</span>
            {inlinePreview ? (
              <span className="flex min-w-0 shrink-[9999] items-center gap-1 text-muted-foreground">
                <span aria-hidden="true" className="shrink-0">
                  ·
                </span>
                <span className="min-w-0 truncate font-mono text-2xs">{inlinePreview}</span>
              </span>
            ) : null}
            <ChevronRight className="size-3 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          aria-label={popoverTitle}
          className="w-96 max-w-[calc(100vw-2rem)]"
          wheelScroll
        >
          <div className="flex max-h-[var(--radix-popover-content-available-height)] flex-col text-xs">
            <div className="border-b border-border/60 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-medium text-foreground">{popoverTitle}</p>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                  {files.complete ? files.count : `${files.count}+`}
                </span>
              </div>
              <p className="mt-0.5 text-muted-foreground">
                {files.complete
                  ? t(
                      'components.workspace.delete.ignoredFiles.popoverDescription',
                      'Only in this worktree — not in the main checkout.'
                    )
                  : t(
                      'components.workspace.delete.ignoredFiles.popoverIncompleteNotice',
                      'Check stopped early; more ignored files in this worktree may also be deleted.'
                    )}
              </p>
            </div>
            <div
              role="region"
              aria-label={popoverTitle}
              className="scrollbar-sleek max-h-56 min-w-0 overflow-y-auto px-3 py-2"
            >
              <ul className="min-w-0 space-y-1 font-mono">
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
            </div>
            {remainingPathCount > 0 ? (
              <p className="border-t border-border/60 px-3 py-1.5 text-muted-foreground">
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
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
