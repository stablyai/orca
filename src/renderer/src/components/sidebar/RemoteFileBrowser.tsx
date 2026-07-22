/* eslint-disable max-lines -- Why: the remote file browser centralizes filter state, path-mode preview state, cache, debounce, request gen, and click/keyboard handling in one component so picker navigation stays coherent. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, ArrowUp, LoaderCircle, Home, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import {
  decideEnterAction,
  decideEscAction,
  filterEntries,
  isRemoteFileBrowserPathResolveTextTooLarge,
  isPathMode,
  joinPath,
  parentPath,
  parsePathInput,
  resolveSegmentStep,
  shouldDeferRemoteFileBrowserPasteResolve,
  type DirEntry
} from './remote-file-browser-helpers'
import { browseRuntimeServerDirectory } from '@/runtime/runtime-server-directory-browser'
import { translate } from '@/i18n/i18n'

type RemoteFileBrowserProps = (
  | { targetId: string; runtimeEnvironmentId?: never }
  | { runtimeEnvironmentId: string; targetId?: never }
) & {
  initialPath?: string
  onSelect: (path: string) => void
  onCancel: () => void
}

const FILE_HINT_MS = 2000
const FILE_HINT_TEXT = "Files can't be opened as a project"
const PATH_DEBOUNCE_MS = 300

type BrowseResult = { resolvedPath: string; entries: DirEntry[] }

type PreviewState = {
  resolvedPath: string
  entries: DirEntry[]
  filter: string
  error: string | null
  loading: boolean
}

export function RemoteFileBrowser({
  targetId,
  runtimeEnvironmentId,
  initialPath = '~',
  onSelect,
  onCancel
}: RemoteFileBrowserProps): React.JSX.Element {
  const [resolvedPath, setResolvedPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [fileHint, setFileHint] = useState(false)
  // Drives the list during path mode; separate from committed state so typing doesn't move the Select target before commit.
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const genRef = useRef(0)
  const previewGenRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why: paste resolution runs next tick; closing the picker before then must cancel stale preview work.
  const pasteResolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Per-picker listing cache keyed by resolved path, so typing issues at most one remote call per committed segment.
  const listingCacheRef = useRef<Map<string, BrowseResult>>(new Map())
  // Resolved remote home, cached after the first browseDir('~'); anchors `~`/`~/...` without hardcoding a home dir.
  const homePathRef = useRef<string | null>(null)
  // Committed-path portion (through the final `/`) the preview reflects; if unchanged next keystroke, skip re-resolving.
  const lastCommittedPrefixRef = useRef<string>('')

  const clearFileHint = useCallback(() => {
    if (fileHintTimerRef.current) {
      clearTimeout(fileHintTimerRef.current)
      fileHintTimerRef.current = null
    }
    setFileHint(false)
  }, [])

  const invalidateBrowseRequests = useCallback(() => {
    genRef.current++
    previewGenRef.current++
  }, [])

  const setBrowserRootRef = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node !== null) {
        return
      }
      // Why: browse generations and timers are scoped to this picker owner; clear them when it detaches.
      invalidateBrowseRequests()
      for (const timerRef of [
        fileHintTimerRef,
        debounceTimerRef,
        pasteResolveTimerRef,
        clickTimerRef
      ]) {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    },
    [invalidateBrowseRequests]
  )

  const fetchListing = useCallback(
    async (dirPath: string): Promise<BrowseResult> => {
      const cached = listingCacheRef.current.get(dirPath)
      if (cached) {
        return cached
      }
      const result = targetId
        ? await window.api.ssh.browseDir({ targetId, dirPath })
        : await browseRuntimeServerDirectory(
            requireRuntimeEnvironmentId(runtimeEnvironmentId),
            dirPath
          )
      listingCacheRef.current.set(result.resolvedPath, result)
      // Also key by the requested dirPath (e.g. `~`, relative) so an identical request doesn't re-hit the SSH backend.
      if (dirPath !== result.resolvedPath) {
        listingCacheRef.current.set(dirPath, result)
      }
      return result
    },
    [runtimeEnvironmentId, targetId]
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
        // Only bare `~` yields the home dir itself; `~/sub` resolves elsewhere and must not overwrite the home anchor.
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
    [fetchListing]
  )

  // Central nav clears filter/preview/hint and bumps previewGenRef so a stale in-flight preview won't clobber committed state.
  const navigate = useCallback(
    (dirPath: string) => {
      setFilter('')
      setPreview(null)
      previewGenRef.current++
      lastCommittedPrefixRef.current = ''
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      clearFileHint()
      loadDir(dirPath)
    },
    [loadDir, clearFileHint]
  )

  useEffect(() => {
    loadDir(initialPath)
  }, [loadDir, initialPath])

  const navigateInto = useCallback(
    (name: string) => {
      navigate(joinPath(resolvedPath, name))
    },
    [resolvedPath, navigate]
  )

  const navigateUp = useCallback(() => {
    if (resolvedPath === '/') {
      return
    }
    navigate(parentPath(resolvedPath))
  }, [resolvedPath, navigate])

  const filteredEntries = useMemo(() => filterEntries(entries, filter), [entries, filter])

  const previewFilteredEntries = useMemo(
    () => (preview ? filterEntries(preview.entries, preview.filter) : []),
    [preview]
  )

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

  // Resolve a path-mode input into preview state; stable callback so paste and the debounce tick share one instance.
  const resolvePathInput = useCallback(
    async (raw: string) => {
      const parsed = parsePathInput(raw)
      if (parsed.mode !== 'path') {
        return
      }
      const gen = ++previewGenRef.current

      if (parsed.invalid) {
        setPreview({
          resolvedPath: resolvedPath,
          entries: [],
          filter: '',
          error: parsed.invalid,
          loading: false
        })
        return
      }

      // Pick the base path; `~` needs the resolved home, so fetch and cache it once before resolving.
      let basePath: string
      if (parsed.base === 'root') {
        basePath = '/'
      } else if (parsed.base === 'home') {
        if (!homePathRef.current) {
          setPreview({
            resolvedPath: resolvedPath,
            entries: [],
            filter: '',
            error: null,
            loading: true
          })
          try {
            const home = await fetchListing('~')
            if (gen !== previewGenRef.current) {
              return
            }
            homePathRef.current = home.resolvedPath
          } catch (err) {
            if (gen !== previewGenRef.current) {
              return
            }
            setPreview({
              resolvedPath,
              entries: [],
              filter: '',
              error: err instanceof Error ? err.message : String(err),
              loading: false
            })
            return
          }
        }
        basePath = homePathRef.current!
      } else {
        basePath = resolvedPath
      }

      setPreview((prev) => ({
        resolvedPath: prev?.resolvedPath ?? basePath,
        entries: prev?.entries ?? [],
        filter: prev?.filter ?? '',
        error: null,
        loading: true
      }))

      let currentPath = basePath
      try {
        for (const segment of parsed.committedSegments) {
          const listing = await fetchListing(currentPath)
          if (gen !== previewGenRef.current) {
            return
          }
          const outcome = resolveSegmentStep(segment, currentPath, listing.entries)
          if (outcome.type === 'error') {
            setPreview({
              resolvedPath: currentPath,
              entries: listing.entries,
              filter: '',
              error: outcome.message,
              loading: false
            })
            return
          }
          if (outcome.type === 'stay') {
            if (segment === '..') {
              currentPath = parentPath(currentPath)
            }
            continue
          }
          currentPath = joinPath(currentPath, outcome.name)
        }

        const finalListing = await fetchListing(currentPath)
        if (gen !== previewGenRef.current) {
          return
        }
        lastCommittedPrefixRef.current = committedPrefix(raw)
        setPreview({
          resolvedPath: finalListing.resolvedPath,
          entries: finalListing.entries,
          filter: parsed.trailingFilter,
          error: null,
          loading: false
        })
      } catch (err) {
        if (gen !== previewGenRef.current) {
          return
        }
        setPreview({
          resolvedPath: currentPath,
          entries: [],
          filter: '',
          error: err instanceof Error ? err.message : String(err),
          loading: false
        })
      }
    },
    [resolvedPath, fetchListing]
  )

  // Filter-mode edits stay local; path-mode edits trigger a debounced resolve, but trailing-filter-only edits stay local too.
  const handleInputChange = useCallback(
    (raw: string) => {
      clearFileHint()
      setFilter(raw)

      if (isRemoteFileBrowserPathResolveTextTooLarge(raw)) {
        if (preview) {
          setPreview(null)
          previewGenRef.current++
        }
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        if (pasteResolveTimerRef.current) {
          clearTimeout(pasteResolveTimerRef.current)
          pasteResolveTimerRef.current = null
        }
        return
      }

      if (!isPathMode(raw)) {
        // Leaving path mode: drop preview immediately so the committed directory reappears without a flicker.
        if (preview) {
          setPreview(null)
          previewGenRef.current++
        }
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        return
      }

      const parsed = parsePathInput(raw)
      // Fast path: unchanged committed prefix updates only the local filter, so intra-segment typing issues no browseDir call.
      if (
        parsed.mode === 'path' &&
        preview &&
        !preview.error &&
        !parsed.invalid &&
        committedPrefix(raw) === lastCommittedPrefixRef.current
      ) {
        // Runs even while preview.loading: unchanged prefix hits the same listing, so blocking keystrokes would only feel laggy.
        setPreview({ ...preview, filter: parsed.trailingFilter })
        return
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        resolvePathInput(raw)
      }, PATH_DEBOUNCE_MS)
    },
    [clearFileHint, preview, resolvePathInput]
  )

  const handleInputPaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      if (e.defaultPrevented) {
        return
      }
      if (shouldDeferRemoteFileBrowserPasteResolve(e.clipboardData.getData('text/plain'))) {
        return
      }
      // Paste resolves immediately (no debounce), but defer a tick so onChange has applied the pasted value to filter.
      if (pasteResolveTimerRef.current) {
        clearTimeout(pasteResolveTimerRef.current)
      }
      pasteResolveTimerRef.current = setTimeout(() => {
        pasteResolveTimerRef.current = null
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        const value = inputRef.current?.value ?? ''
        if (!isRemoteFileBrowserPathResolveTextTooLarge(value) && isPathMode(value)) {
          resolvePathInput(value)
        }
      }, 0)
    },
    [resolvePathInput]
  )

  // Select always returns the committed directory; disabled during a path preview to avoid a mismatched selection.
  const handleSelect = useCallback(() => {
    onSelect(resolvedPath)
  }, [resolvedPath, onSelect])

  // When a preview is active, row clicks resolve relative to the preview path, not the committed resolvedPath.
  const listParentPath = preview?.resolvedPath ?? resolvedPath

  const handleRowClick = useCallback(
    (entry: DirEntry) => {
      // Stale rows from the prior listing may still show while a preview resolves; clicking them would navigate a mismatched path.
      if (preview?.loading) {
        return
      }
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        if (entry.isDirectory) {
          navigate(joinPath(listParentPath, entry.name))
        } else {
          triggerFileHint()
        }
      }, 220)
    },
    [navigate, triggerFileHint, listParentPath, preview?.loading]
  )

  const handleRowDoubleClick = useCallback(
    (entry: DirEntry) => {
      // Same as handleRowClick: don't act on stale rows while the preview listing re-resolves.
      if (!entry.isDirectory || preview?.loading) {
        return
      }
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      onSelect(joinPath(listParentPath, entry.name))
    },
    [listParentPath, onSelect, preview?.loading]
  )

  const handleFilterKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (preview) {
          // Path mode Enter.
          if (preview.error || preview.loading) {
            e.preventDefault()
            return
          }
          const parsed = parsePathInput(filter)
          // Fully-resolved directory (trailing `/` or bare base marker): navigate to the preview path itself.
          if (parsed.mode === 'path' && parsed.trailingFilter === '') {
            e.preventDefault()
            navigate(preview.resolvedPath)
            return
          }
          // Trailing filter: resolve to a single folder match in the preview listing, mirroring filter-mode Enter.
          const filtered = filterEntries(preview.entries, preview.filter)
          const action = decideEnterAction(filtered)
          if (action.type === 'navigate') {
            e.preventDefault()
            navigate(joinPath(preview.resolvedPath, action.name))
          } else if (action.type === 'fileHint') {
            e.preventDefault()
            triggerFileHint()
          } else {
            e.preventDefault()
          }
          return
        }
        const action = decideEnterAction(filteredEntries)
        if (action.type === 'navigate') {
          e.preventDefault()
          navigateInto(action.name)
        } else if (action.type === 'fileHint') {
          e.preventDefault()
          triggerFileHint()
        }
        return
      }
      if (e.key === 'Escape') {
        const action = decideEscAction(filter)
        if (action.type === 'clearFilter') {
          e.stopPropagation()
          e.preventDefault()
          setFilter('')
          setPreview(null)
          previewGenRef.current++
          // Cancel any pending debounced resolve so it can't fire after Escape dismisses the preview.
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current)
            debounceTimerRef.current = null
          }
          clearFileHint()
        } else {
          onCancel()
        }
      }
      if (e.key === 'Backspace' && filter === '' && !preview) {
        // Backspace in an empty input climbs to the parent; in-word backspaces are untouched.
        if (resolvedPath !== '/') {
          e.preventDefault()
          navigateUp()
        }
      }
    },
    [
      filter,
      filteredEntries,
      preview,
      navigate,
      navigateInto,
      navigateUp,
      resolvedPath,
      triggerFileHint,
      clearFileHint,
      onCancel
    ]
  )

  const pathSegments = resolvedPath.split('/').filter(Boolean)

  // Render the preview listing (own filter/error) during path mode, the committed listing otherwise.
  const isPreviewActive = preview !== null
  const showPreviewLoading = isPreviewActive && preview!.loading
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

  // Disable Select during a non-empty path preview so the committed dir isn't silently selected under a different-looking list.
  const selectDisabled = loading || (isPreviewActive && filter !== '')

  return (
    <div ref={setBrowserRootRef} className="flex flex-col gap-2 min-w-0 w-full">
      {/* Breadcrumb bar */}
      <div className="flex items-center gap-0.5 min-h-[28px] overflow-x-auto scrollbar-none">
        <button
          type="button"
          onClick={navigateUp}
          disabled={resolvedPath === '/' || loading}
          className="shrink-0 p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => navigate('~')}
          disabled={loading}
          className="shrink-0 p-1 rounded hover:bg-accent transition-colors cursor-pointer"
        >
          <Home className="size-3.5" />
        </button>
        <div className="flex items-center gap-0 text-[11px] text-muted-foreground ml-1 min-w-0">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="shrink-0 hover:text-foreground transition-colors cursor-pointer px-0.5"
          >
            /
          </button>
          {pathSegments.map((segment, i) => (
            <React.Fragment key={i}>
              <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
              <button
                type="button"
                onClick={() => navigate(`/${pathSegments.slice(0, i + 1).join('/')}`)}
                className={cn(
                  'truncate max-w-[120px] hover:text-foreground transition-colors cursor-pointer px-0.5',
                  i === pathSegments.length - 1 && 'text-foreground font-medium'
                )}
              >
                {segment}
              </button>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Filter input */}
      <div className="relative">
        <Search className="size-3.5 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
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

      {/* File listing */}
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
                {translate(
                  'auto.components.sidebar.RemoteFileBrowser.51001182e3',
                  'Empty directory'
                )}
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

      {/* Footer */}
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

// Portion of raw before the final `/`; lets callers tell a trailing-filter-only edit from a committed-segment change.
function committedPrefix(raw: string): string {
  const i = raw.lastIndexOf('/')
  return i === -1 ? '' : raw.slice(0, i + 1)
}

function requireRuntimeEnvironmentId(runtimeEnvironmentId: string | undefined): string {
  if (!runtimeEnvironmentId) {
    throw new Error('Runtime environment is required')
  }
  return runtimeEnvironmentId
}
