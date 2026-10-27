import type React from 'react'
import { useEffect, useRef, type RefObject } from 'react'
import { ChevronRight, Folder, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import {
  isRemoteFileBrowserPathResolveTextTooLarge,
  type DirEntry
} from './remote-file-browser-helpers'
import type { PreviewState } from './remote-file-browser-path-preview-resolver'
import { translate } from '@/i18n/i18n'
import { collapseHomePath } from '../../../../shared/bundled-skill-locations'

type RemoteFileBrowserEntryListProps = {
  loading: boolean
  error: string | null
  entries: DirEntry[]
  displayEntries: readonly DirEntry[]
  activeIndex: number
  projectFolders: readonly string[]
  /** Resolved `~` of the browsed host, once listed; folder rows read relative to it. */
  homePath: string | null
  activeProjectFolderIndex: number
  listboxId: string
  filter: string
  preview: PreviewState | null
  isPreviewActive: boolean
  inputRef: RefObject<HTMLInputElement | null>
  handleRowClick: (entry: DirEntry) => void
  handleRowDoubleClick: (entry: DirEntry) => void
  handlePathClick: (dirPath: string) => void
  handlePathDoubleClick: (dirPath: string) => void
}

export function remoteFileBrowserProjectFolderOptionId(listboxId: string, index: number): string {
  return `${listboxId}-folder-${index}`
}

const ROW_CLASS_NAME = cn(
  // Why `jump-palette-item`: flat accent is invisible as a keyboard cursor on light dialogs.
  'jump-palette-item w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors cursor-pointer',
  'hover:bg-accent/60'
)

export function RemoteFileBrowserEntryList({
  loading,
  error,
  entries,
  displayEntries,
  activeIndex,
  projectFolders,
  homePath,
  activeProjectFolderIndex,
  listboxId,
  filter,
  preview,
  isPreviewActive,
  inputRef,
  handleRowClick,
  handleRowDoubleClick,
  handlePathClick,
  handlePathDoubleClick
}: RemoteFileBrowserEntryListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const selector =
      activeIndex >= 0
        ? `[data-entry-index="${activeIndex}"]`
        : activeProjectFolderIndex >= 0
          ? `[data-project-folder-index="${activeProjectFolderIndex}"]`
          : null
    if (selector === null) {
      return
    }
    // Optional call: happy-dom has no scrollIntoView.
    scrollRef.current?.querySelector(selector)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, activeProjectFolderIndex, displayEntries, projectFolders])
  const projectFoldersLabelId = `${listboxId}-folders-label`

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
        {projectFolders.length > 0 && (
          <div
            role="group"
            aria-labelledby={projectFoldersLabelId}
            className="border-b border-border pb-1"
          >
            <div
              id={projectFoldersLabelId}
              role="presentation"
              className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {translate(
                'auto.components.sidebar.RemoteFileBrowserEntryList.projectFolders',
                'Project folders'
              )}
            </div>
            {projectFolders.map((folderPath, index) => {
              const isActive = index === activeProjectFolderIndex
              return (
                <button
                  key={folderPath}
                  id={remoteFileBrowserProjectFolderOptionId(listboxId, index)}
                  role="option"
                  aria-selected={isActive}
                  data-selected={isActive}
                  data-project-folder-index={index}
                  tabIndex={-1}
                  type="button"
                  title={folderPath}
                  onClick={() => handlePathClick(folderPath)}
                  onDoubleClick={() => handlePathDoubleClick(folderPath)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    inputRef.current?.focus()
                  }}
                  className={ROW_CLASS_NAME}
                >
                  <Folder className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1 min-w-0 font-mono text-2xs">
                    {homePath ? collapseHomePath(folderPath, homePath) : folderPath}
                  </span>
                  <ChevronRight className="size-3.5 text-muted-foreground/60 shrink-0" />
                </button>
              )
            })}
          </div>
        )}
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
          <div
            className={cn(
              'flex items-center justify-center',
              projectFolders.length > 0 ? 'py-8' : 'h-full'
            )}
          >
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
                className={ROW_CLASS_NAME}
              >
                {entry.isDirectory ? (
                  <Folder className="size-3.5 text-muted-foreground shrink-0" />
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
