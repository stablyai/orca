import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, File } from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'

/**
 * Simple fuzzy match: checks if all characters in the query appear in order
 * within the target string (case-insensitive). Returns a score (lower = better)
 * or -1 if no match.
 */
function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let lastMatchIdx = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Bonus for consecutive matches
      const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
      score += gap
      // Bonus for matching after separator (/ or .)
      if (ti > 0 && (t[ti - 1] === '/' || t[ti - 1] === '.' || t[ti - 1] === '-')) {
        score -= 5 // reward
      }
      lastMatchIdx = ti
      qi++
    }
  }

  if (qi < q.length) {
    return -1 // not all chars matched
  }

  // Prefer matches where query appears in the filename (last segment)
  const lastSlash = target.lastIndexOf('/')
  const filename = target.slice(lastSlash + 1).toLowerCase()
  if (filename.includes(q)) {
    score -= 100 // strong reward for filename match
  }

  return score
}

export default function QuickOpen(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.quickOpenVisible)
  const setVisible = useAppStore((s) => s.setQuickOpenVisible)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const openFile = useAppStore((s) => s.openFile)

  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Find active worktree path
  const worktreePath = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  // Load file list when opened
  useEffect(() => {
    if (!visible) {
      return
    }

    if (!worktreePath) {
      setFiles([])
      setSelectedIndex(0)
      return
    }

    let cancelled = false
    setQuery('')
    setSelectedIndex(0)
    setFiles([])
    setLoadError(null)
    setLoading(true)

    void window.api.fs
      .listFiles({ rootPath: worktreePath })
      .then((result) => {
        if (!cancelled) {
          setFiles(result)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFiles([])
          // Why: treating list-files failures as "no matches" hides the real
          // cause when the active worktree path is unauthorized or stale.
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    // Focus input after mount
    requestAnimationFrame(() => inputRef.current?.focus())

    return () => {
      cancelled = true
    }
  }, [visible, worktreePath])

  // Filter files by fuzzy match
  const filtered = useMemo(() => {
    if (!query.trim()) {
      // Show first 50 files when no query
      return files.slice(0, 50).map((f) => ({ path: f, score: 0 }))
    }
    const results: { path: string; score: number }[] = []
    for (const f of files) {
      const score = fuzzyMatch(query.trim(), f)
      if (score !== -1) {
        results.push({ path: f, score })
      }
    }
    results.sort((a, b) => a.score - b.score)
    return results.slice(0, 50)
  }, [files, query])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filtered])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) {
      return
    }
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleSelect = useCallback(
    (relativePath: string) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      setVisible(false)
      openFile({
        filePath: joinPath(worktreePath, relativePath),
        relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(relativePath),
        mode: 'edit'
      })
    },
    [activeWorktreeId, worktreePath, openFile, setVisible]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setVisible(false)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (filtered.length > 0) {
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (filtered.length > 0) {
          setSelectedIndex((i) => Math.max(i - 1, 0))
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[selectedIndex]
        if (item) {
          handleSelect(item.path)
        }
      }
    },
    [setVisible, filtered, selectedIndex, handleSelect]
  )

  if (!visible) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-8"
      onClick={() => setVisible(false)}
    >
      <div
        className="w-[660px] max-w-[90vw] bg-background border border-border rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 border-b border-border">
          <Search size={14} className="text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent text-sm py-2.5 outline-none text-foreground placeholder:text-muted-foreground"
            placeholder="Go to file..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
        </div>

        {/* Results list — only rendered when there is content to avoid empty padding */}
        {(loading || query.trim() || filtered.length > 0) && (
          <div ref={listRef} className="max-h-[300px] overflow-y-auto scrollbar-sleek pb-1">
            {loading && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                Loading files...
              </div>
            )}
            {!loading && loadError && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                Could not load files: {loadError}
              </div>
            )}
            {filtered.length === 0 && query.trim() && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No matching files
              </div>
            )}
            {filtered.map((item, idx) => {
              const lastSlash = item.path.lastIndexOf('/')
              const dir = lastSlash >= 0 ? item.path.slice(0, lastSlash) : ''
              const filename = item.path.slice(lastSlash + 1)

              return (
                <button
                  key={item.path}
                  type="button"
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/50 ${
                    idx === selectedIndex ? 'bg-accent' : ''
                  }`}
                  onClick={() => handleSelect(item.path)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <File size={14} className="text-muted-foreground flex-shrink-0" />
                  <span className="truncate text-foreground">{filename}</span>
                  {dir && <span className="truncate text-muted-foreground ml-1">{dir}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
