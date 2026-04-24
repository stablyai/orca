import { useEffect, useMemo, useRef, useState } from 'react'
import { File, Folder, Plus, X } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { SearchableSetting } from './SearchableSetting'

type WorktreeSymlinksSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
}

type DirEntry = { name: string; isDirectory: boolean }

const MAX_SUGGESTIONS = 50

export function WorktreeSymlinksSection({
  repo,
  updateRepo
}: WorktreeSymlinksSectionProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const blurTimerRef = useRef<number | null>(null)

  const paths = repo.symlinkPaths ?? []
  const draftTrimmed = draft.trim().replace(/^\/+/, '')

  useEffect(() => {
    let cancelled = false
    void window.api.fs
      .readDir({ dirPath: repo.path, connectionId: repo.connectionId ?? undefined })
      .then((list) => {
        if (cancelled) {
          return
        }
        setEntries(
          list.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory }))
        )
      })
      .catch(() => {
        // Non-fatal: without entries the combobox just works as a plain free-text
        // input — the user can still type any path and commit it.
      })
    return () => {
      cancelled = true
    }
  }, [repo.path, repo.connectionId])

  const filtered = useMemo(() => {
    const query = draftTrimmed.toLowerCase()
    const base = query
      ? entries.filter((e) => e.name.toLowerCase().includes(query))
      : entries
    return base.slice(0, MAX_SUGGESTIONS)
  }, [draftTrimmed, entries])

  const hasExactMatch = filtered.some((e) => e.name === draftTrimmed)
  const showLiteralItem = draftTrimmed.length > 0 && !hasExactMatch && !paths.includes(draftTrimmed)
  const showDropdown = focused && (filtered.length > 0 || showLiteralItem)

  const commit = (rawName: string): void => {
    const trimmed = rawName.trim().replace(/^\/+/, '')
    if (!trimmed || paths.includes(trimmed)) {
      setDraft('')
      return
    }
    updateRepo(repo.id, { symlinkPaths: [...paths, trimmed] })
    setDraft('')
  }

  const handleRemove = (path: string): void => {
    updateRepo(repo.id, { symlinkPaths: paths.filter((p) => p !== path) })
  }

  const handleContainerFocus = (): void => {
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    setFocused(true)
  }

  const handleContainerBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    // Why: CommandItem click lands as a focus change *out* of the input before
    // its onSelect fires. Defer closing so the click can register; if focus
    // lands back inside the container (another item / the input), cancel the
    // pending close.
    const nextTarget = e.relatedTarget as Node | null
    if (nextTarget && containerRef.current?.contains(nextTarget)) {
      return
    }
    blurTimerRef.current = window.setTimeout(() => {
      setFocused(false)
      blurTimerRef.current = null
    }, 120)
  }

  return (
    <SearchableSetting
      title="Worktree Symlinks"
      description="Paths to symlink from the primary checkout into newly created worktrees."
      keywords={[
        repo.displayName,
        'symlink',
        'symlinks',
        'worktree',
        'link',
        'shared',
        'env',
        'node_modules'
      ]}
      className="space-y-3"
    >
      <div className="space-y-1">
        <Label>Worktree Symlinks</Label>
        <p className="text-xs text-muted-foreground">
          When a new worktree is created, each path listed here will be symlinked from the primary
          checkout. Type to search files and folders in the repo root, or add any relative path.
        </p>
      </div>

      <div
        ref={containerRef}
        onFocus={handleContainerFocus}
        onBlur={handleContainerBlur}
        className="relative"
      >
        <Command shouldFilter={false} className="overflow-visible bg-transparent">
          <CommandInput
            value={draft}
            onValueChange={setDraft}
            placeholder="Type a path (e.g. .env or node_modules)…"
            wrapperClassName="rounded-md border"
          />
          {showDropdown ? (
            <div className="absolute top-full left-0 right-0 z-20 mt-1 overflow-hidden rounded-md border bg-popover shadow-md">
              <CommandList className="max-h-64">
                <CommandEmpty>No matches. Keep typing to add a custom path.</CommandEmpty>
                {showLiteralItem ? (
                  <CommandItem
                    value={`__literal__:${draftTrimmed}`}
                    onSelect={() => commit(draftTrimmed)}
                    className="gap-2"
                  >
                    <Plus className="size-3.5 text-muted-foreground" />
                    <span className="text-sm">
                      Add <code className="rounded bg-muted px-1 py-0.5 text-xs">{draftTrimmed}</code>
                    </span>
                  </CommandItem>
                ) : null}
                {filtered.map((entry) => {
                  const alreadyAdded = paths.includes(entry.name)
                  return (
                    <CommandItem
                      key={entry.name}
                      value={entry.name}
                      disabled={alreadyAdded}
                      onSelect={() => commit(entry.name)}
                      className="gap-2"
                    >
                      {entry.isDirectory ? (
                        <Folder className="size-3.5 text-muted-foreground" />
                      ) : (
                        <File className="size-3.5 text-muted-foreground" />
                      )}
                      <span className="truncate text-sm">{entry.name}</span>
                      {alreadyAdded ? (
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                          added
                        </span>
                      ) : null}
                    </CommandItem>
                  )
                })}
              </CommandList>
            </div>
          ) : null}
        </Command>
      </div>

      {paths.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No paths configured.</p>
      ) : (
        <ul className="space-y-1">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5"
            >
              <code className="truncate text-xs">{path}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleRemove(path)}
                aria-label={`Remove ${path}`}
                className="h-6 w-6 p-0"
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SearchableSetting>
  )
}
