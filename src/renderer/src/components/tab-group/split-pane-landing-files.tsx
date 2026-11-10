import { useDeferredValue, useMemo } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { splitTrailingSegment } from '@/components/file-path-cursor-tooltip'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { useQuickOpenHistory } from '@/lib/quick-open-file-history'
import { useRuntimeFileListForWorktree } from '@/components/quick-open-file-list'
import { parseQuickOpenQueryTarget } from '../../../../shared/quick-open/quick-open-query-target'
import { openQuickOpenFile } from '../quick-open-file-navigation'
import { rankQuickOpenFilesWithHistory } from '../quick-open-history-ranking'

const MAX_FILE_RESULTS = 8

/** Go to File's search, shown only once the user types; recent files stay in Go to File. */
export function LandingFileResults({
  worktreeId,
  worktreePath,
  query
}: {
  worktreeId: string
  worktreePath: string
  query: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const deferredQuery = useDeferredValue(query.trim())
  const target = useMemo(() => parseQuickOpenQueryTarget(deferredQuery), [deferredQuery])
  const history = useQuickOpenHistory(worktreeId, worktreePath)
  const { files } = useRuntimeFileListForWorktree({
    enabled: deferredQuery !== '',
    worktreeId,
    query: target.pathQuery,
    recentPaths: history
  })
  const matches = useMemo(
    () =>
      deferredQuery === ''
        ? []
        : rankQuickOpenFilesWithHistory(target.pathQuery, files, history).slice(
            0,
            MAX_FILE_RESULTS
          ),
    [deferredQuery, target.pathQuery, files, history]
  )
  if (matches.length === 0) {
    return null
  }
  return (
    <CommandGroup heading={t('components.tabGroup.splitPaneLanding.files', 'Files')}>
      {matches.map(({ path }) => {
        const { directory, filename } = splitTrailingSegment(path)
        return (
          <CommandItem
            key={path}
            value={`file:${path}`}
            selection="palette"
            onSelect={() => {
              void openQuickOpenFile(path, worktreeId, worktreePath, target, deferredQuery).catch(
                (error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
              )
            }}
          >
            <FileTypeIcon filePath={path} className="size-4 text-muted-foreground" />
            <span className="min-w-0 max-w-full shrink-0 truncate">{filename}</span>
            {directory ? (
              <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                {directory}
              </span>
            ) : null}
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
