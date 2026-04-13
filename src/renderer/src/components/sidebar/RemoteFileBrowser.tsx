import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder, File, ArrowUp, LoaderCircle, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type DirEntry = {
  name: string
  isDirectory: boolean
}

type RemoteFileBrowserProps = {
  targetId: string
  initialPath?: string
  onSelect: (path: string) => void
  onCancel: () => void
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
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const genRef = useRef(0)

  const loadDir = useCallback(
    async (dirPath: string) => {
      const gen = ++genRef.current
      setLoading(true)
      setError(null)
      setSelectedName(null)
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

  useEffect(() => {
    loadDir(initialPath)
  }, [loadDir, initialPath])

  const navigateTo = useCallback(
    (name: string) => {
      const next = resolvedPath === '/' ? `/${name}` : `${resolvedPath}/${name}`
      loadDir(next)
    },
    [resolvedPath, loadDir]
  )

  const navigateUp = useCallback(() => {
    if (resolvedPath === '/') {
      return
    }
    const parent = resolvedPath.replace(/\/[^/]+\/?$/, '') || '/'
    loadDir(parent)
  }, [resolvedPath, loadDir])

  const handleDoubleClick = useCallback(
    (entry: DirEntry) => {
      if (entry.isDirectory) {
        navigateTo(entry.name)
      }
    },
    [navigateTo]
  )

  const handleSelect = useCallback(() => {
    if (selectedName) {
      const full = resolvedPath === '/' ? `/${selectedName}` : `${resolvedPath}/${selectedName}`
      onSelect(full)
    } else {
      onSelect(resolvedPath)
    }
  }, [resolvedPath, selectedName, onSelect])

  const pathSegments = resolvedPath.split('/').filter(Boolean)

  return (
    <div className="flex flex-col gap-2">
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
          onClick={() => loadDir('~')}
          disabled={loading}
          className="shrink-0 p-1 rounded hover:bg-accent transition-colors cursor-pointer"
        >
          <Home className="size-3.5" />
        </button>
        <div className="flex items-center gap-0 text-[11px] text-muted-foreground ml-1 min-w-0">
          <button
            type="button"
            onClick={() => loadDir('/')}
            className="shrink-0 hover:text-foreground transition-colors cursor-pointer px-0.5"
          >
            /
          </button>
          {pathSegments.map((segment, i) => (
            <React.Fragment key={i}>
              <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
              <button
                type="button"
                onClick={() => loadDir(`/${pathSegments.slice(0, i + 1).join('/')}`)}
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
          ) : (
            entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors cursor-pointer',
                  'hover:bg-accent/60',
                  selectedName === entry.name && 'bg-accent'
                )}
                onClick={() => setSelectedName(entry.name)}
                onDoubleClick={() => handleDoubleClick(entry)}
              >
                {entry.isDirectory ? (
                  <Folder className="size-3.5 text-blue-400 shrink-0" />
                ) : (
                  <File className="size-3.5 text-muted-foreground/60 shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-muted-foreground truncate">
          {selectedName ? `${resolvedPath}/${selectedName}` : resolvedPath}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={handleSelect} disabled={loading}>
            Select
          </Button>
        </div>
      </div>
    </div>
  )
}
