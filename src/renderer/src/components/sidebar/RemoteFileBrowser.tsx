import { ImeInput } from '@/lib/ime-text-field'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { filterEntries, joinPath, parentPath, type DirEntry } from './remote-file-browser-helpers'
import { RemoteFileBrowserBreadcrumbs } from './RemoteFileBrowserBreadcrumbs'
import { RemoteFileBrowserEntryList } from './RemoteFileBrowserEntryList'
import { useRemoteFileBrowserFilterKeyCommands } from './use-remote-file-browser-filter-key-commands'
import { useRemoteFileBrowserListing } from './use-remote-file-browser-listing'
import { useRemoteFileBrowserPathPreview } from './use-remote-file-browser-path-preview'
import { translate } from '@/i18n/i18n'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'

// Both IDs select an SSH host owned and listed by the paired server.
type RemoteFileBrowserProps = (
  | { targetId: string; runtimeEnvironmentId?: string }
  | { runtimeEnvironmentId: string; targetId?: never }
) & {
  initialPath?: string
  onSelect: (path: string) => void
  onCancel: () => void
}

const FILE_HINT_MS = 2000
const FILE_HINT_TEXT = "Files can't be opened as a project"

export function RemoteFileBrowser({
  targetId,
  runtimeEnvironmentId,
  initialPath = '~',
  onSelect,
  onCancel
}: RemoteFileBrowserProps): React.JSX.Element {
  const [resolvedPath, setResolvedPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [pathFlavor, setPathFlavor] = useState<FilesystemPathFlavor>('posix')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [fileHint, setFileHint] = useState(false)
  const genRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { fetchListing, homePathRef } = useRemoteFileBrowserListing(targetId, runtimeEnvironmentId)

  const clearFileHint = useCallback(() => {
    if (fileHintTimerRef.current) {
      clearTimeout(fileHintTimerRef.current)
      fileHintTimerRef.current = null
    }
    setFileHint(false)
  }, [])

  const {
    preview,
    handleInputChange,
    handleInputPaste,
    discardPreview,
    resetPreviewForNavigation,
    cancelPreviewWork
  } = useRemoteFileBrowserPathPreview({
    resolvedPath,
    pathFlavor,
    fetchListing,
    homePathRef,
    inputRef,
    clearFileHint,
    setFilter
  })

  const invalidateBrowseRequests = useCallback(() => {
    genRef.current++
  }, [])

  const setBrowserRootRef = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node !== null) {
        return
      }
      // Cancel owner-scoped browse generations/timers when this picker detaches.
      invalidateBrowseRequests()
      cancelPreviewWork()
      for (const timerRef of [fileHintTimerRef, clickTimerRef]) {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    },
    [invalidateBrowseRequests, cancelPreviewWork]
  )

  const loadDir = useCallback(
    async (dirPath: string) => {
      const gen = ++genRef.current
      setLoading(true)
      setError(null)
      try {
        const result = await fetchListing(dirPath)
        if (gen !== genRef.current) {
          return
        }
        setResolvedPath(result.resolvedPath)
        setEntries(result.entries)
        setPathFlavor(result.pathFlavor)
        // Only bare ~ resolves the home anchor; ~/sub must not replace it.
        if (dirPath === '~') {
          homePathRef.current = result.resolvedPath
        }
      } catch (err) {
        if (gen !== genRef.current) {
          return
        }
        setError(err instanceof Error ? err.message : String(err))
        setEntries([])
      } finally {
        if (gen === genRef.current) {
          setLoading(false)
        }
      }
    },
    [fetchListing, homePathRef]
  )

  // Invalidate preview generations on navigation so stale reads cannot overwrite committed state.
  const navigate = useCallback(
    (dirPath: string) => {
      setFilter('')
      resetPreviewForNavigation()
      clearFileHint()
      loadDir(dirPath)
    },
    [loadDir, clearFileHint, resetPreviewForNavigation]
  )

  useEffect(() => {
    loadDir(initialPath)
  }, [loadDir, initialPath])

  const navigateInto = useCallback(
    (name: string) => {
      navigate(joinPath(resolvedPath, name, pathFlavor))
    },
    [resolvedPath, navigate, pathFlavor]
  )

  const navigateUp = useCallback(() => {
    if (resolvedPath === '/') {
      return
    }
    navigate(parentPath(resolvedPath, pathFlavor))
  }, [resolvedPath, navigate, pathFlavor])

  const filteredEntries = useMemo(() => filterEntries(entries, filter), [entries, filter])

  const triggerFileHint = useCallback(() => {
    if (fileHintTimerRef.current) {
      clearTimeout(fileHintTimerRef.current)
    }
    setFileHint(true)
    fileHintTimerRef.current = setTimeout(() => {
      setFileHint(false)
      fileHintTimerRef.current = null
    }, FILE_HINT_MS)
  }, [])

  const handleSelect = useCallback(() => {
    onSelect(resolvedPath)
  }, [resolvedPath, onSelect])

  // Preview rows resolve against their preview path rather than the committed directory.
  const listParentPath = preview?.resolvedPath ?? resolvedPath

  const handleRowClick = useCallback(
    (entry: DirEntry) => {
      // Old rows can remain during preview resolution; ignore clicks until their parent path is known.
      if (preview?.loading) {
        return
      }
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        if (entry.isDirectory) {
          navigate(joinPath(listParentPath, entry.name, pathFlavor))
        } else {
          triggerFileHint()
        }
      }, 220)
    },
    [navigate, triggerFileHint, listParentPath, preview?.loading, pathFlavor]
  )

  const handleRowDoubleClick = useCallback(
    (entry: DirEntry) => {
      if (!entry.isDirectory || preview?.loading) {
        return
      }
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      onSelect(joinPath(listParentPath, entry.name, pathFlavor))
    },
    [listParentPath, onSelect, preview?.loading, pathFlavor]
  )

  const handleFilterKeyDown = useRemoteFileBrowserFilterKeyCommands({
    filter,
    setFilter,
    filteredEntries,
    preview,
    discardPreview,
    resolvedPath,
    pathFlavor,
    navigate,
    navigateInto,
    navigateUp,
    triggerFileHint,
    clearFileHint,
    onCancel
  })

  const isPreviewActive = preview !== null
  const showPreviewLoading = isPreviewActive && preview!.loading

  // Disable Select while previewing another path so visible and selected directories cannot disagree.
  const selectDisabled = loading || (isPreviewActive && filter !== '')

  return (
    <div ref={setBrowserRootRef} className="flex flex-col gap-2 min-w-0 w-full">
      <RemoteFileBrowserBreadcrumbs
        resolvedPath={resolvedPath}
        pathFlavor={pathFlavor}
        loading={loading}
        navigate={navigate}
        navigateUp={navigateUp}
      />

      <div className="relative">
        <Search className="size-3.5 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
        <ImeInput
          ref={inputRef}
          type="text"
          autoFocus
          value={filter}
          onChange={(e) => handleInputChange(e.target.value)}
          onPaste={handleInputPaste}
          onKeyDown={handleFilterKeyDown}
          placeholder={translate(
            'auto.components.sidebar.RemoteFileBrowser.2300612806',
            'Type to filter or enter a path…'
          )}
          aria-invalid={!!preview?.error}
          aria-describedby={preview?.error ? 'remote-file-browser-path-error' : undefined}
          className={cn(
            'w-full h-7 pl-7 pr-7 text-xs rounded-md bg-background',
            'border border-border focus:outline-none focus:ring-1 focus:ring-ring',
            preview?.error && 'border-destructive/60 focus:ring-destructive/60'
          )}
        />
        {showPreviewLoading && (
          <LoaderCircle className="size-3.5 absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {preview?.error && (
        <p
          id="remote-file-browser-path-error"
          role="alert"
          className="text-[11px] text-destructive px-0.5 -mt-1"
        >
          {preview.error}
        </p>
      )}

      <RemoteFileBrowserEntryList
        loading={loading}
        error={error}
        entries={entries}
        filteredEntries={filteredEntries}
        filter={filter}
        preview={preview}
        isPreviewActive={isPreviewActive}
        inputRef={inputRef}
        handleRowClick={handleRowClick}
        handleRowDoubleClick={handleRowDoubleClick}
      />

      <p
        className="block text-[10px] text-muted-foreground truncate w-full"
        title={fileHint ? undefined : resolvedPath}
      >
        {fileHint
          ? FILE_HINT_TEXT
          : translate(
              'auto.components.sidebar.RemoteFileBrowser.971d85cc84',
              'Opens as a project on this host · {{value0}}',
              { value0: resolvedPath }
            )}
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onCancel}>
          {translate('auto.components.sidebar.RemoteFileBrowser.f8b1deb1a4', 'Cancel')}
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={handleSelect}
          disabled={selectDisabled}
          title={resolvedPath}
        >
          {translate('auto.components.sidebar.RemoteFileBrowser.9e060f5815', 'Select folder')}
        </Button>
      </div>
    </div>
  )
}
