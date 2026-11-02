import type React from 'react'
import { useEffect, useRef, type RefObject } from 'react'
import { ChevronRight, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileTypeIcon, FolderIcon } from '@/components/FileTypeIcon'
import {
  isRemoteFileBrowserPathResolveTextTooLarge,
  type DirEntry
} from './remote-file-browser-helpers'
import type { PreviewState } from './remote-file-browser-path-preview-resolver'
import { translate } from '@/i18n/i18n'

type RemoteFileBrowserEntryListProps = {
  loading: boolean
  error: string | null
  entries: DirEntry[]
  displayEntries: readonly DirEntry[]
  activeIndex: number
  listboxId: string
  filter: string
  preview: PreviewState | null
  isPreviewActive: boolean
  inputRef: RefObject<HTMLInputElement | null>
  handleRowClick: (entry: DirEntry) => void
  handleRowDoubleClick: (entry: DirEntry) => void
}

export function RemoteFileBrowserEntryList({
  loading,
  error,
  entries,
  displayEntries,
  activeIndex,
  listboxId,
  filter,
  preview,
  isPreviewActive,
  inputRef,
  handleRowClick,
  handleRowDoubleClick
}: RemoteFileBrowserEntryListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (activeIndex < 0) {
      return
    }
    // Optional call: happy-dom has no scrollIntoView.
    scrollRef.current
      ?.querySelector(`[data-entry-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, displayEntries])

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
      <div
        ref={scrollRef}
        id={listboxId}
        role="listbox"
        aria-label={translate(
          'auto.components.sidebar.RemoteFileBrowser.entriesLabel',
          'Folder entries'
        )}
        className="h-[240px] overflow-y-auto scrollbar-sleek"
      >
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
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.sidebar.RemoteFileBrowserEntryList.pathEmpty',
                '{{path}} is empty',
                { path: preview!.resolvedPath }
              )}
            </p>
          </div>
        ) : !isPreviewActive && entries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.sidebar.RemoteFileBrowser.51001182e3', 'Empty directory')}
            </p>
          </div>
        ) : displayEntries.length === 0 && !preview?.error ? (
          // Filtered-out entries need different copy from a directory that is genuinely empty.
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-muted-foreground">{displayNoMatchesCopy}</p>
          </div>
        ) : (
          displayEntries.map((entry, index) => {
            const isActive = index === activeIndex
            return (
              <button
                key={entry.name}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={isActive}
                data-selected={isActive}
                data-entry-index={index}
                tabIndex={-1}
                type="button"
                onClick={() => handleRowClick(entry)}
                onDoubleClick={() => handleRowDoubleClick(entry)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  inputRef.current?.focus()
                }}
                className={cn(
                  // Why `jump-palette-item`: flat accent is invisible as a keyboard cursor on light dialogs.
                  'jump-palette-item w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors cursor-pointer',
                  'hover:bg-accent/60'
                )}
              >
                {entry.isDirectory ? (
                  <FolderIcon
                    folderPath={entry.name}
                    open={false}
                    className="size-3.5 text-muted-foreground shrink-0"
                  />
                ) : (
                  <FileTypeIcon
                    filePath={entry.name}
                    className="size-3.5 text-muted-foreground/60 shrink-0"
                  />
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
