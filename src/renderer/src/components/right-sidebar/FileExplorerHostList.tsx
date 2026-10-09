import React, { useDeferredValue, useLayoutEffect, useMemo, useState } from 'react'
import { CornerLeftUp, Folder, Link } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { VirtualizedList } from '@/components/virtualized-list'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { FileExplorerTreeStatus } from './FileExplorerTreeStatus'
import { filterHostEntries } from './file-explorer-host-mode'
import type { FileExplorerHostMode } from './use-file-explorer-host-mode'

const ROW_CLASS =
  'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-foreground'

function HostEntryIcon({ entry }: { entry: DirEntry }): React.JSX.Element {
  if (entry.isDirectory) {
    return <Folder className="size-3 shrink-0 text-muted-foreground" />
  }
  if (entry.isSymlink) {
    return <Link className="size-3 shrink-0 text-muted-foreground" />
  }
  return React.createElement(getFileTypeIcon(entry.name), {
    className: 'size-3 shrink-0 text-muted-foreground'
  })
}

export function FileExplorerHostList({
  hostMode,
  showDotfiles
}: {
  hostMode: FileExplorerHostMode
  showDotfiles: boolean
}): React.JSX.Element {
  const { browser, filterQuery } = hostMode
  const deferredQuery = useDeferredValue(filterQuery)
  const listingEntries = browser.listing?.entries
  const entries = useMemo(
    () => (listingEntries ? filterHostEntries(listingEntries, deferredQuery, showDotfiles) : []),
    [listingEntries, deferredQuery, showDotfiles]
  )
  // Why: state, not a ref, so the virtualizer observes the scroller once it attaches.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const resolvedPath = browser.listing?.resolvedPath ?? null
  // Why: a new folder or filter starts at the top; reloading the same folder (refresh, a failed
  // navigation) keeps the user's place.
  useLayoutEffect(() => {
    if (scrollElement) {
      scrollElement.scrollTop = 0
    }
  }, [scrollElement, resolvedPath, deferredQuery])
  const status = (
    <FileExplorerTreeStatus
      isLoading={browser.showLoading && !browser.listing}
      error={browser.error}
      isEmpty={browser.listing !== null && entries.length === 0}
      scopedToFolder
    />
  )
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-1 py-1 transition-opacity duration-150 motion-reduce:transition-none',
        // Why: a slow (SSH) navigation dims the folder still on screen instead of freezing silently.
        browser.showLoading && browser.listing && 'opacity-60'
      )}
      ref={setScrollElement}
      data-file-explorer-host-list=""
      // Why: tree shortcuts (Delete, rename, paste) act on the hidden tree's selection.
      data-ignore-file-explorer-keys="true"
    >
      {browser.canNavigateUp ? (
        <button type="button" className={ROW_CLASS} onClick={browser.navigateUp}>
          <CornerLeftUp className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {translate('fileExplorer.host.parentDirectory', 'Parent directory')}
          </span>
        </button>
      ) : null}
      {browser.error !== null || !browser.listing || entries.length === 0 ? (
        <div className="h-full">{status}</div>
      ) : (
        // Why: host folders like /usr/lib hold tens of thousands of entries; only the viewport mounts.
        <VirtualizedList
          rows={entries}
          scrollElement={scrollElement}
          getRowKey={(entry) => entry.name}
          renderRow={(entry) => (
            <button
              key={entry.name}
              type="button"
              className={ROW_CLASS}
              title={entry.name}
              onClick={() => browser.activateEntry(entry)}
            >
              <HostEntryIcon entry={entry} />
              <span className="truncate">{entry.name}</span>
            </button>
          )}
        />
      )}
    </div>
  )
}
