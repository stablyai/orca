import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, ChevronsUpDown, Folder, LoaderCircle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getWorktreeSymlinkPathFilterState } from '@/components/settings/worktree-symlink-path-filter'
import { joinPath } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import {
  getSparseBrowseTrail,
  joinSparseBrowsePath,
  listBrowsableDirectories
} from './sparse-directory-browse'
import { parseSparseDirectoryEntryInput } from './sparse-directory-entry-input'

type SparseDirectoryPickerProps = {
  rootPath: string
  connectionId?: string
  selected: string[]
  disabled: boolean
  describedById?: string
  onAdd: (directories: string[]) => void
}

type BrowseState =
  | { status: 'loading' }
  | { status: 'ready'; directories: string[] }
  | { status: 'error' }

export function SparseDirectoryPicker({
  rootPath,
  connectionId,
  selected,
  disabled,
  describedById,
  onAdd
}: SparseDirectoryPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [relativePath, setRelativePath] = useState('')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<BrowseState>({ status: 'loading' })

  useEffect(() => {
    if (!open || !rootPath) {
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    void window.api.fs
      .readDir({ dirPath: joinPath(rootPath, relativePath), connectionId })
      .then((entries) => {
        if (!cancelled) {
          setState({ status: 'ready', directories: listBrowsableDirectories(entries) })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, rootPath, relativePath, connectionId])

  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setRelativePath('')
      setQuery('')
    }
  }, [])

  const commit = useCallback(
    (raw: string): void => {
      const { entries } = parseSparseDirectoryEntryInput(raw)
      if (entries.length > 0) {
        onAdd(entries)
      }
      setQuery('')
      handleOpenChange(false)
    },
    [handleOpenChange, onAdd]
  )

  const { queryTrimmed, filtered, showLiteralItem } = useMemo(
    () =>
      getWorktreeSymlinkPathFilterState({
        query,
        suggestions:
          state.status === 'ready'
            ? state.directories.map((name) => ({ name, isDirectory: true }))
            : [],
        existingPaths: selected
      }),
    [query, state, selected]
  )
  // Why: free-form typing is repo-relative, so it must not inherit the browsed folder.
  const literalError = showLiteralItem ? parseSparseDirectoryEntryInput(queryTrimmed).error : null
  const trail = getSparseBrowseTrail(relativePath)

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          // Why: combobox takes no name from content, so the visible label is not enough.
          aria-label={translate('sparsePreset.addPath', 'Add a folder')}
          aria-expanded={open}
          aria-describedby={describedById}
          disabled={disabled || !rootPath}
          className="w-full justify-between"
        >
          <span className="truncate">{translate('sparsePreset.addPath', 'Add a folder')}</span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)]"
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex max-h-[min(var(--radix-popover-content-available-height),22rem)] flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
            <button
              type="button"
              className="rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
              onClick={() => setRelativePath('')}
            >
              {translate('sparsePreset.repositoryRoot', 'Repository root')}
            </button>
            {trail.map((segment) => (
              <span key={segment.path} className="flex items-center gap-0.5">
                <ChevronRight className="size-3 opacity-50" />
                <button
                  type="button"
                  className="max-w-32 truncate rounded px-1 py-0.5 font-mono hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setRelativePath(segment.path)}
                >
                  {segment.name}
                </button>
              </span>
            ))}
          </div>
          <Command shouldFilter={false} className="min-h-0 flex-1">
            <CommandInput
              placeholder={translate(
                'sparsePreset.findOrTypePath',
                'Find a folder, or type any path…'
              )}
              aria-label={translate(
                'sparsePreset.findOrTypePath',
                'Find a folder, or type any path…'
              )}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="min-h-0 flex-1">
              <CommandEmpty>
                {state.status === 'loading'
                  ? translate('sparsePreset.loadingPaths', 'Reading folders…')
                  : state.status === 'error'
                    ? translate(
                        'sparsePreset.pathsUnavailable',
                        'Could not read this folder. Type the path instead.'
                      )
                    : translate('sparsePreset.noPathMatches', 'No folders found.')}
              </CommandEmpty>
              {showLiteralItem ? (
                literalError ? (
                  <p className="px-3 py-2 text-xs text-destructive">{literalError}</p>
                ) : (
                  <CommandItem
                    value={`__literal__:${queryTrimmed}`}
                    onSelect={() => commit(queryTrimmed)}
                  >
                    <Plus className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs">
                      {translate('sparsePreset.addTypedPath', 'Add')}{' '}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                        {queryTrimmed}
                      </code>
                    </span>
                  </CommandItem>
                )
              ) : null}
              {state.status === 'loading' ? (
                <div className="flex items-center justify-center py-4">
                  <LoaderCircle className="size-4 animate-spin opacity-60" />
                </div>
              ) : null}
              {filtered.map((entry) => {
                const path = joinSparseBrowsePath(relativePath, entry.name)
                const alreadySelected = selected.includes(path)
                return (
                  <CommandItem
                    key={path}
                    value={path}
                    disabled={alreadySelected}
                    onSelect={() => commit(path)}
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate font-mono text-xs">{entry.name}</span>
                    {alreadySelected ? (
                      <span className="text-[11px] text-muted-foreground">
                        {translate('sparsePreset.pathAdded', 'Added')}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={translate('sparsePreset.openFolder', 'Open {{name}}', {
                        name: entry.name
                      })}
                      onClick={(event) => {
                        event.stopPropagation()
                        setRelativePath(path)
                        setQuery('')
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.stopPropagation()
                        }
                      }}
                    >
                      <ChevronRight />
                    </Button>
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  )
}
