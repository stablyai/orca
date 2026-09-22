import type React from 'react'
import { useMemo, type RefObject } from 'react'
import { ChevronRight, Folder, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import {
  filterEntries,
  isRemoteFileBrowserPathResolveTextTooLarge,
  type DirEntry
} from './remote-file-browser-helpers'
import type { PreviewState } from './remote-file-browser-path-preview-resolver'
import { translate } from '@/i18n/i18n'

type RemoteFileBrowserEntryListProps = {
  loading: boolean
  error: string | null
  entries: DirEntry[]
  filteredEntries: DirEntry[]
  filter: string
  preview: PreviewState | null
  isPreviewActive: boolean
  inputRef: RefObject<HTMLInputElement | null>
  handleRowClick: (entry: DirEntry) => void
  handleRowDoubleClick: (entry: DirEntry) => void
}

/** File listing */
export function RemoteFileBrowserEntryList({
  loading,
  error,
  entries,
  filteredEntries,
  filter,
  preview,
  isPreviewActive,
  inputRef,
  handleRowClick,
  handleRowDoubleClick
}: RemoteFileBrowserEntryListProps): React.JSX.Element {
  const previewFilteredEntries = useMemo(
    () => (preview ? filterEntries(preview.entries, preview.filter) : []),
    [preview]
  )

  // Render the preview listing (own filter/error) during path mode, the committed listing otherwise.
  const displayEntries = isPreviewActive ? previewFilteredEntries : filteredEntries
  const displayEmptyDirCopy = isPreviewActive
    ? `${preview!.resolvedPath} is empty`
    : 'Empty directory'
  const noMatchesFilter = isPreviewActive ? preview!.filter : filter
  const displayNoMatchesCopy = isRemoteFileBrowserPathResolveTextTooLarge(noMatchesFilter)
    ? translate(
        'auto.components.sidebar.RemoteFileBrowser.largeInputNoMatches',
        'No matches for this long input'
      )
    : translate(
        'auto.components.sidebar.RemoteFileBrowser.00c4235c10',
        "No matches for '{{value0}}'",
        { value0: noMatchesFilter }
      )

  return (
    <div className="border border-border rounded-md overflow-hidden bg-background">
      <div className="h-[240px] overflow-y-auto scrollbar-sleek">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full px-4">
            <p className="text-xs text-destructive text-center">{error}</p>
          </div>
        ) : isPreviewActive &&
          preview!.entries.length === 0 &&
          !preview!.error &&
          !preview!.loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-muted-foreground">{displayEmptyDirCopy}</p>
          </div>
        ) : !isPreviewActive && entries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.sidebar.RemoteFileBrowser.51001182e3', 'Empty directory')}
            </p>
          </div>
        ) : displayEntries.length === 0 && !preview?.error ? (
          // Directory has contents but the filter hides them all — distinct from an empty directory so copy stays accurate.
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-muted-foreground">{displayNoMatchesCopy}</p>
            <p className="text-xs text-muted-foreground">{displayNoMatchesCopy}</p>
          </div>
        ) : (
          displayEntries.map((entry) => {
            const FileIcon = getFileTypeIcon(entry.name)
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => handleRowClick(entry)}
                onDoubleClick={() => handleRowDoubleClick(entry)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  inputRef.current?.focus()
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors cursor-pointer',
                  'hover:bg-accent/60'
                )}
              >
                {entry.isDirectory ? (
                  <Folder className="size-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <FileIcon className="size-3.5 text-muted-foreground/60 shrink-0" />
                )}
                <span className="truncate flex-1 min-w-0">{entry.name}</span>
                {entry.isDirectory && (
                  <ChevronRight className="size-3.5 text-muted-foreground/60 shrink-0" />
                )}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
