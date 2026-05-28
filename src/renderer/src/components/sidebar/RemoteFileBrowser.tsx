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
  isPathMode,
  joinPath,
  parentPath,
  parsePathInput,
  resolveSegmentStep,
  type DirEntry
} from './remote-file-browser-helpers'

type RemoteFileBrowserProps = {
  targetId: string
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
  // Preview state drives the list while path mode is active. It is kept
  // separate from committed state so typing `Documents/` does not silently
  // change the `Select folder` target before the user commits.
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const genRef = useRef(0)
  const previewGenRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cache directory listings by absolute resolved path for the lifetime of
  // the picker so ordinary typing issues at most one remote call per newly
  // committed segment. targetId does not change within a picker instance.
  const listingCacheRef = useRef<Map<string, BrowseResult>>(new Map())
  // Resolved remote home, cached after the first `browseDir('~')`. Used to
  // anchor `~` and `~/...` paths without hardcoding a home directory.
  const homePathRef = useRef<string | null>(null)
  // The committed-path portion of the raw input that the current preview
  // reflects (everything up to and including the final `/`). If the user's
  // next keystroke leaves this unchanged, we can skip re-resolving.
  const lastCommittedPrefixRef = useRef<string>('')

  const clearFileHint = useCallback(() => {
    if (fileHintTimerRef.current) {
      clearTimeout(fileHintTimerRef.current)
      fileHintTimerRef.current = null
    }
    setFileHint(false)
  }, [])

  useEffect(() => {
    return () => {
      if (fileHintTimerRef.current) {
        clearTimeout(fileHintTimerRef.current)
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  const fetchListing = useCallback(
    async (dirPath: string): Promise<BrowseResult> => {
      const cached = listingCacheRef.current.get(dirPath)
      if (cached) {
        return cached
      }
      const result = await window.api.ssh.browseDir({ targetId, dirPath })
      listingCacheRef.current.set(result.resolvedPath, result)
      // Also cache under the requested dirPath when it differs from the
      // server-resolved canonical path (e.g. `~`, `~/foo`, or a relative
      // input). Without this, the next identical request would miss the
      // cache and re-hit the SSH backend.
      if (dirPath !== result.resolvedPath) {
        listingCacheRef.current.set(dirPath, result)
      }
      return result
    },
    [targetId]
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
        // Only the bare-tilde listing returns the home directory itself;
        // `~/sub` resolves to `.../sub`, which must not overwrite the home
        // anchor used for resolving later `~/...` inputs.
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

  // All user-initiated navigation goes through this wrapper so filter +
  // preview + hint state is always cleared. Bumping previewGenRef here
  // ensures any in-flight path preview whose target is no longer relevant
  // can't overwrite committed state after a breadcrumb or row click.
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

  // Resolve a path-mode input and push the result into preview state.
  // Exposed as a ref-callback so it can run immediately on paste or on the
  // debounce tick without re-creating on every keystroke.
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

      // Pick the base path. For `~` we must know the resolved home; if we
      // haven't fetched it yet, fetch once (and cache it) before resolving.
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

  // Called on every user edit to the input. Filter-mode edits stay local;
  // path-mode edits trigger a debounced resolve. Partial trailing-segment
  // changes that don't change committed segments only update the preview
  // filter, so typing `Documents/orc` → `Documents/orca` is free.
  const handleInputChange = useCallback(
    (raw: string) => {
      clearFileHint()
      setFilter(raw)

      if (!isPathMode(raw)) {
        // Leaving path mode: drop preview immediately so the committed
        // directory re-appears without a flicker.
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
      // Partial trailing-segment edits: if the committed-path portion of the
      // input is unchanged from what the preview already resolved, update
      // only the local filter. This is the fast path that guarantees typing
      // `Documents/orc` → `Documents/orca` issues no `browseDir` call.
      if (
        parsed.mode === 'path' &&
        preview &&
        !preview.error &&
        !parsed.invalid &&
        committedPrefix(raw) === lastCommittedPrefixRef.current
      ) {
        // Intentionally allow this fast path to run even while
        // preview.loading is true: the committed prefix is unchanged, so
        // the in-flight resolve will land on the same listing and only the
        // trailing filter needs updating. Blocking on loading would make
        // keystrokes during a slow resolve feel unresponsive.
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
    (_e: React.ClipboardEvent<HTMLInputElement>) => {
      // Paste resolves immediately; no debounce. React's onChange still fires
      // after the paste is applied to the input value, so we defer to the
      // next tick so `filter` reflects the pasted value.
      setTimeout(() => {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        const value = inputRef.current?.value ?? ''
        if (isPathMode(value)) {
          resolvePathInput(value)
        }
      }, 0)
    },
    [resolvePathInput]
  )

  // Select always returns the committed current directory. Disabled while a
  // path-mode preview is visible so the user can't silently select the old
  // committed directory while the list shows a different preview directory.
  const handleSelect = useCallback(() => {
    onSelect(resolvedPath)
  }, [resolvedPath, onSelect])

  // Single-click navigates; double-click on a folder selects it.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }
    }
  }, [])

  // When preview is active, row clicks must be relative to the preview path,
  // not the committed `resolvedPath`.
  const listParentPath = preview?.resolvedPath ?? resolvedPath

  const handleRowClick = useCallback(
    (entry: DirEntry) => {
      // Stale entries from the previous resolved listing can remain on
      // screen while a new preview resolves; clicking them would navigate
      // relative to a path that no longer matches what the user is typing.
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
      // Same rationale as handleRowClick: do not act on stale rows while
      // the preview listing is being re-resolved.
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
          // Fully-resolved directory (trailing `/` or bare base marker):
          // navigate to the preview path itself.
          if (parsed.mode === 'path' && parsed.trailingFilter === '') {
            e.preventDefault()
            navigate(preview.resolvedPath)
            return
          }
          // Trailing filter — try to resolve it to a single folder match in
          // the preview listing, mirroring filter-mode Enter.
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
          // Cancel any pending debounced resolve so it can't fire after
          // the user has already dismissed the preview with Escape.
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
        // Backspace in an empty input climbs to the parent — only when the
        // caret is in empty text, so in-word Backspaces are untouched.
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

  // What the list should render: preview listing (with its own filter and
  // error) during path mode, committed listing otherwise.
  const isPreviewActive = preview !== null
  const showPreviewLoading = isPreviewActive && preview!.loading
  const displayEntries = isPreviewActive ? previewFilteredEntries : filteredEntries
  const displayEmptyDirCopy = isPreviewActive
    ? `${preview!.resolvedPath} is empty`
    : 'Empty directory'

  // Disable Select folder while a non-empty path-mode preview is visible so
  // the committed directory isn't silently selected while the list shows a
  // different preview directory.
  const selectDisabled = loading || (isPreviewActive && filter !== '')

  return (
    <div className="flex flex-col gap-2 min-w-0 w-full">
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
          placeholder="Type to filter or enter a path…"
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
              <p className="text-xs text-muted-foreground">Empty directory</p>
            </div>
          ) : displayEntries.length === 0 && !preview?.error ? (
            // Directory has contents; filter hides them all. Distinguishing
            // filter emptiness from directory emptiness keeps copy accurate.
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">{`No matches for '${
                isPreviewActive ? preview!.filter : filter
              }'`}</p>
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
        {fileHint ? FILE_HINT_TEXT : `Opens as a remote project · ${resolvedPath}`}
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={handleSelect}
          disabled={selectDisabled}
          title={resolvedPath}
        >
          Select folder
        </Button>
      </div>
    </div>
  )
}

// Returns the portion of `raw` before its final `/`, used to decide whether
// a keystroke only changed the trailing filter (cheap local update) or
// changed a committed segment (requires re-resolving).
function committedPrefix(raw: string): string {
  const i = raw.lastIndexOf('/')
  return i === -1 ? '' : raw.slice(0, i + 1)
}
