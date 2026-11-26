import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { WorktreePurgeTarget } from '@/store/slices/worktrees/teardown/worktree-purge-target'
import { useRemovalUnsavedFiles } from './use-removal-unsaved-files'
import { discardedUnsavedFilesLabel, moreUnsavedFilesLabel } from './removal-unsaved-files'
import { useTranslate } from '@/i18n/use-translate'

const MAX_LISTED_FILES = 5

/** Memoize targets so the removal notice observes a stable set of affected editor files. */
export function RemovalUnsavedFilesNotice({
  targets,
  enabled
}: {
  targets: readonly WorktreePurgeTarget[]
  enabled: boolean
}): JSX.Element | null {
  const t = useTranslate()
  const files = useRemovalUnsavedFiles(targets, enabled)

  if (files.length === 0) {
    return null
  }
  const hidden = files.length - MAX_LISTED_FILES
  return (
    <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          {discardedUnsavedFilesLabel(files.length, t)}
          <ul className="mt-1 min-w-0 space-y-0.5">
            {files.slice(0, MAX_LISTED_FILES).map((file) => (
              <li key={file.id} className="truncate text-foreground" title={file.filePath}>
                {file.relativePath || file.filePath}
              </li>
            ))}
            {hidden > 0 && <li>{moreUnsavedFilesLabel(hidden, t)}</li>}
          </ul>
        </div>
      </div>
    </div>
  )
}
