import { useEffect, useMemo, useState } from 'react'
import { Folder, Link2, Plus, X } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '@/lib/utils'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { SearchableSetting } from './SearchableSetting'
import {
  getWorktreeSymlinkPathFilterState,
  type WorktreeSymlinkPathSuggestion
} from './worktree-symlink-path-filter'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

type WorktreeSymlinksSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
}

type DirectorySuggestionState = {
  requestKey: string
  entries: WorktreeSymlinkPathSuggestion[]
}

const EMPTY_WORKTREE_SYMLINK_PATHS: readonly string[] = []

export function WorktreeSymlinksSection({
  repo,
  updateRepo
}: WorktreeSymlinksSectionProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const activeRuntimeEnvironmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId)

  const paths = repo.symlinkPaths ?? EMPTY_WORKTREE_SYMLINK_PATHS
  const useLocalDirectorySuggestions = !activeRuntimeEnvironmentId?.trim()
  const directorySuggestionKey = `${repo.path}\n${repo.connectionId ?? ''}`
  const [directorySuggestions, setDirectorySuggestions] = useState<DirectorySuggestionState>(
    () => ({
      requestKey: directorySuggestionKey,
      entries: []
    })
  )

  useEffect(() => {
    if (!useLocalDirectorySuggestions) {
      return
    }
    let cancelled = false
    void window.api.fs
      .readDir({ dirPath: repo.path, connectionId: repo.connectionId ?? undefined })
      .then((list) => {
        if (cancelled) {
          return
        }
        setDirectorySuggestions({
          requestKey: directorySuggestionKey,
          entries: list.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory }))
        })
      })
      .catch(() => {
        // Non-fatal: without entries the combobox still works as a free-text
        // input — the user can type any path and commit it.
      })
    return () => {
      cancelled = true
    }
  }, [useLocalDirectorySuggestions, repo.path, repo.connectionId, directorySuggestionKey])

  const { queryTrimmed, filtered, showLiteralItem } = useMemo(() => {
    const suggestionEntries =
      useLocalDirectorySuggestions && directorySuggestions.requestKey === directorySuggestionKey
        ? directorySuggestions.entries
        : []
    return getWorktreeSymlinkPathFilterState({
      query,
      suggestions: suggestionEntries,
      existingPaths: paths
    })
  }, [query, paths, directorySuggestionKey, directorySuggestions, useLocalDirectorySuggestions])

  const commit = (rawName: string): void => {
    const trimmed = rawName.trim().replace(/^\/+/, '')
    if (!trimmed || paths.includes(trimmed)) {
      setQuery('')
      return
    }
    updateRepo(repo.id, { symlinkPaths: [...paths, trimmed] })
    setQuery('')
    setOpen(false)
  }

  const handleRemove = (path: string): void => {
    updateRepo(repo.id, { symlinkPaths: paths.filter((p) => p !== path) })
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.WorktreeSymlinksSection.4755f120b6',
        'Worktree Shared Paths'
      )}
      description={translate(
        'auto.components.settings.WorktreeSymlinksSection.b07ef5a8b6',
        'Paths to materialize from the primary checkout into newly created worktrees.'
      )}
      keywords={[
        repo.displayName,
        'apfs',
        'clone',
        'copy',
        'symlink',
        'symlinks',
        'worktree',
        'link',
        'shared',
        'env',
        'node_modules'
      ]}
      className="space-y-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.settings.WorktreeSymlinksSection.4755f120b6',
              'Worktree Shared Paths'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.WorktreeSymlinksSection.7ff265071d',
              'When a new worktree is created, each path listed here is APFS clone-copied on macOS when possible, otherwise symlinked from the primary checkout.'
            )}
          </p>
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Plus className="size-3.5" />
              {translate('auto.components.settings.WorktreeSymlinksSection.241325302c', 'Add Path')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-0">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={translate(
                  'auto.components.settings.WorktreeSymlinksSection.4cd2a4c077',
                  'Type a path (e.g. .env or node_modules)…'
                )}
                value={query}
                onValueChange={setQuery}
              />
              <CommandList>
                <CommandEmpty>
                  {translate(
                    'auto.components.settings.WorktreeSymlinksSection.ab40b8a5f1',
                    'No matches. Keep typing to add a custom path.'
                  )}
                </CommandEmpty>
                {showLiteralItem ? (
                  <CommandItem
                    value={`__literal__:${queryTrimmed}`}
                    onSelect={() => commit(queryTrimmed)}
                    className="items-center gap-2 px-3 py-2"
                  >
                    <Plus className="size-3.5 text-muted-foreground" />
                    <span className="text-xs">
                      {translate(
                        'auto.components.settings.WorktreeSymlinksSection.b2429aeb31',
                        'Add'
                      )}{' '}
                      <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                        {queryTrimmed}
                      </code>
                    </span>
                  </CommandItem>
                ) : null}
                {filtered.map((entry) => {
                  const alreadyAdded = paths.includes(entry.name)
                  const FileIcon = getFileTypeIcon(entry.name)
                  return (
                    <CommandItem
                      key={entry.name}
                      value={entry.name}
                      disabled={alreadyAdded}
                      onSelect={() => commit(entry.name)}
                      className={cn('items-center gap-2 px-3 py-2', alreadyAdded && 'opacity-50')}
                    >
                      {entry.isDirectory ? (
                        <Folder className="size-3.5 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-3.5 text-muted-foreground" />
                      )}
                      <span className="truncate text-xs">{entry.name}</span>
                      {alreadyAdded ? (
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                          {translate(
                            'auto.components.settings.WorktreeSymlinksSection.ea06227efa',
                            'added'
                          )}
                        </span>
                      ) : null}
                    </CommandItem>
                  )
                })}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {paths.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.WorktreeSymlinksSection.31ebab5403',
            'No shared paths configured for this repository.'
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-background/70 px-4 py-3 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/30">
              <Link2 className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h4 className="text-sm font-medium">
                  {translate(
                    'auto.components.settings.WorktreeSymlinksSection.b814c618e2',
                    'Linked paths'
                  )}
                </h4>
                <span className="text-[11px] text-muted-foreground">
                  {paths.length === 1
                    ? translate(
                        'auto.components.settings.WorktreeSymlinksSection.9ea912d811',
                        '1 path'
                      )
                    : translate(
                        'auto.components.settings.WorktreeSymlinksSection.d72ba8dc68',
                        '{{value0}} paths',
                        { value0: paths.length }
                      )}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {paths.map((path) => (
                  <span
                    key={path}
                    title={path}
                    className="inline-flex min-w-0 max-w-full items-center gap-1 truncate rounded-md border border-border/50 bg-muted/35 py-1 pl-2 pr-1 font-mono text-[11px] text-foreground/80"
                  >
                    <span className="truncate">{path}</span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => handleRemove(path)}
                      aria-label={translate(
                        'auto.components.settings.WorktreeSymlinksSection.1c1e35b219',
                        'Remove {{value0}}',
                        { value0: path }
                      )}
                      className="size-4 shrink-0 rounded-sm"
                    >
                      <X className="size-3" />
                    </Button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </SearchableSetting>
  )
}
