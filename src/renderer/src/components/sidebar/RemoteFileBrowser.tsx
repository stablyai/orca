import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, File, ArrowUp, LoaderCircle, Home, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  decideEnterAction,
  decideEscAction,
  filterEntries,
  joinPath,
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
  const genRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    }
  }, [])

  const loadDir = useCallback(
    async (dirPath: string) => {
      const gen = ++genRef.current
      setLoading(true)
      setError(null)
      try {
        const result = await window.api.ssh.browseDir({ targetId, dirPath })
        if (gen !== genRef.current) {
          return
        }
        setResolvedPath(result.resolvedPath)
        setEntries(result.entries)
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
    [targetId]
  )

  // All user-initiated navigation goes through this wrapper so filter + hint
  // state is always cleared. The initial mount calls loadDir directly so a
  // user who types during the first load keeps their input.
  const navigate = useCallback(
    (dirPath: string) => {
      setFilter('')
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
    const parent = resolvedPath.replace(/\/[^/]+\/?$/, '') || '/'
    navigate(parent)
  }, [resolvedPath, navigate])

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

  // Select always returns the current directory. Selection model = "navigate
  // to the folder you want, then Select"; this is the VS Code approach and
  // was chosen after feedback that the highlight-a-row model was confusing.
  const handleSelect = useCallback(() => {
    onSelect(resolvedPath)
  }, [resolvedPath, onSelect])

  // Single-click navigates; double-click on a folder selects it. Because
  // onClick fires on both mousedowns of a dblclick, we have to delay the
  // single-click so a subsequent dblclick can cancel it. 220ms matches the
  // platform dblclick threshold on macOS closely enough that the single-click
  // latency is imperceptible.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }
    }
  }, [])

  const handleRowClick = useCallback(
    (entry: DirEntry) => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        if (entry.isDirectory) {
          navigateInto(entry.name)
        } else {
          // Files aren't navigable and can't be opened as a project — the
          // footer hint keeps the click from being a silent no-op.
          triggerFileHint()
        }
      }, 220)
    },
    [navigateInto, triggerFileHint]
  )

  const handleRowDoubleClick = useCallback(
    (entry: DirEntry) => {
      if (!entry.isDirectory) {
        return
      }
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      onSelect(joinPath(resolvedPath, entry.name))
    },
    [resolvedPath, onSelect]
  )

  const handleFilterKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
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
          clearFileHint()
        } else {
          onCancel()
        }
      }
    },
    [filter, filteredEntries, navigateInto, triggerFileHint, clearFileHint, onCancel]
  )

  const pathSegments = resolvedPath.split('/').filter(Boolean)

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
          onChange={(e) => {
            clearFileHint()
            setFilter(e.target.value)
          }}
          onKeyDown={handleFilterKeyDown}
          placeholder="Type to filter…"
          className={cn(
            'w-full h-7 pl-7 pr-2 text-xs rounded-md bg-background',
            'border border-border focus:outline-none focus:ring-1 focus:ring-ring'
          )}
        />
      </div>

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
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">Empty directory</p>
            </div>
          ) : filteredEntries.length === 0 ? (
            // The directory has contents; the filter just hid them all. Generic
            // "Empty directory" copy would mislead here.
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">{`No matches for '${filter}'`}</p>
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                // Single-click on a folder enters it (feedback: the old
                // click-to-highlight model was undiscoverable). Double-click
                // on a folder selects it directly — the shortcut for users
                // who don't want to step inside first.
                onClick={() => handleRowClick(entry)}
                onDoubleClick={() => handleRowDoubleClick(entry)}
                // Keep focus on the filter input so typing / Enter / Esc keep
                // working after a mouse click on a row.
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
                  <Folder className="size-3.5 text-blue-400 shrink-0" />
                ) : (
                  <File className="size-3.5 text-muted-foreground/60 shrink-0" />
                )}
                <span className="truncate flex-1 min-w-0">{entry.name}</span>
                {entry.isDirectory && (
                  // Chevron is always visible (user feedback): makes the
                  // "click to enter" affordance unambiguous without relying on
                  // hover discovery.
                  <ChevronRight className="size-3.5 text-muted-foreground/60 shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Footer. Path line is on its own row with `block + truncate` so long
          paths can't push the container wider; buttons sit on a separate row
          and are free to align right without competing for space. */}
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
          disabled={loading}
          title={resolvedPath}
        >
          Select folder
        </Button>
      </div>
    </div>
  )
}
