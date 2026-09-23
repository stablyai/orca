import { readRuntimeDirectory } from '../../runtime/runtime-file-client'
import { getRuntimeGitIgnoredPaths } from '../../runtime/runtime-git-status-client'
import { worktreeCopyContext } from './worktree-copy-context'
import { WorktreeLegacyPaths } from './WorktreeLegacyPaths'
import {
  isWorktreeCopyPath,
  parseWorktreeIncludeFile
} from '../../../../shared/worktree-copy-paths'
import { WorktreeCopyProjectPaths } from './WorktreeCopyProjectPaths'
import { useEffect, useState } from 'react'
import { ChevronRight, Plus, X } from 'lucide-react'
import type { Repo } from '../../../../shared/repo-types'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SearchableSetting } from './SearchableSetting'
import {
  getWorktreeSymlinkPathFilterState,
  type WorktreeSymlinkPathSuggestion
} from './worktree-symlink-path-filter'
import { translate } from '@/i18n/i18n'

type WorktreeCopySectionProps = {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: Partial<Repo> | ((repo: Repo) => Partial<Repo>)
  ) => void | Promise<boolean>
}

export function WorktreeCopySection({
  repo,
  updateRepo
}: WorktreeCopySectionProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const paths = repo.worktreeCopyPaths ?? []
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [directorySuggestions, setDirectorySuggestions] = useState<WorktreeSymlinkPathSuggestion[]>(
    []
  )

  useEffect(() => {
    let cancelled = false
    const context = worktreeCopyContext(repo)
    void readRuntimeDirectory(context, repo.path)
      .then(async (list) => {
        const ignored = new Set(
          await getRuntimeGitIgnoredPaths(
            context,
            list.map((entry) => entry.name)
          )
        )
        if (cancelled) {
          return
        }
        setDirectorySuggestions(list.filter((entry) => ignored.has(entry.name)))
      })
      .catch(() => {
        // Non-fatal: without entries the combobox still works as a free-text
        // input — the user can type any path and commit it.
      })
    return () => {
      cancelled = true
    }
  }, [repo])

  const { queryTrimmed, filtered, showLiteralItem } = getWorktreeSymlinkPathFilterState({
    query,
    suggestions: directorySuggestions,
    existingPaths: paths
  })

  const commit = async (rawName: string): Promise<void> => {
    const trimmed = parseWorktreeIncludeFile(rawName)[0] ?? ''
    if (!isWorktreeCopyPath(trimmed)) {
      setError(
        translate(
          'worktreeCopies.invalid',
          'Use a literal path inside this repository, such as .env. Patterns and parent paths are not supported.'
        )
      )
      return
    }
    setError('')
    if (!trimmed || paths.includes(trimmed)) {
      setQuery('')
      return
    }
    setSaving(true)
    try {
      const ignored = await getRuntimeGitIgnoredPaths(worktreeCopyContext(repo), [trimmed])
      if (!ignored.includes(trimmed)) {
        setError(
          translate(
            'worktreeCopies.notIgnored',
            'Choose a file or folder ignored by Git. Tracked files already come from the chosen branch.'
          )
        )
        return
      }
      if (
        (await updateRepo(repo.id, (current) => ({
          worktreeCopyPaths: [...(current.worktreeCopyPaths ?? []), trimmed]
        }))) === false
      ) {
        setError(
          translate(
            'worktreeCopies.saveFailed',
            'Could not save these paths. Check the connection and update the Orca host if needed.'
          )
        )
        return
      }
    } catch {
      setError(
        translate(
          'worktreeCopies.validationFailed',
          'Could not validate this path on its host. Check the connection and try again.'
        )
      )
      return
    } finally {
      setSaving(false)
    }
    setQuery('')
    setOpen(false)
  }

  const removePath = async (path: string): Promise<void> => {
    setSaving(true)
    try {
      const saved = await updateRepo(repo.id, (current) => ({
        worktreeCopyPaths: (current.worktreeCopyPaths ?? []).filter((p) => p !== path)
      }))
      if (saved === false) {
        setError(
          translate(
            'worktreeCopies.saveFailed',
            'Could not save these paths. Check the connection and update the Orca host if needed.'
          )
        )
      }
    } catch {
      setError(
        translate(
          'worktreeCopies.saveFailed',
          'Could not save these paths. Check the connection and update the Orca host if needed.'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <SearchableSetting
      title={translate('worktreeCopies.title', 'Files to copy')}
      description={translate(
        'worktreeCopies.description',
        'Personal files to copy for this repository and host, in addition to .worktreeinclude.'
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
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate('worktreeCopies.title', 'Files to copy')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'worktreeCopies.explanation',
            'Bring ignored files and folders from your primary checkout into each new worktree.'
          )}
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="space-y-1">
            <h4 className="text-xs font-medium">
              {translate('worktreeCopies.personal', 'Your additions')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {translate(
                'worktreeCopies.scope',
                'Saved in Orca for this repository and host only.'
              )}
            </p>
          </div>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={saving}
              >
                <Plus className="size-3.5" />
                {translate('worktreeCopies.add', 'Add path')}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder={translate(
                    'auto.components.settings.WorktreeSymlinksSection.4cd2a4c077',
                    'Type a path (e.g. .env or node_modules)…'
                  )}
                  aria-invalid={Boolean(error)}
                  value={query}
                  onValueChange={(value) => {
                    setQuery(value)
                    setError('')
                  }}
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
                      disabled={saving}
                      onSelect={() => commit(query)}
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
                  {filtered
                    .filter((entry) => !paths.includes(entry.name))
                    .map((entry) => (
                      <CommandItem
                        key={entry.name}
                        value={entry.name}
                        disabled={saving}
                        onSelect={() => commit(entry.name)}
                      >
                        {entry.name}
                        {entry.isDirectory ? '/' : ''}
                      </CommandItem>
                    ))}
                </CommandList>
                {error && (
                  <p
                    role="alert"
                    className="border-t border-border px-3 py-2 text-xs text-destructive"
                  >
                    {error}
                  </p>
                )}
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {paths.length === 0 && (
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            {translate('worktreeCopies.empty', 'No additions yet. Add a path such as .env.local.')}
          </p>
        )}
        {paths.map((path) => (
          <div
            key={path}
            className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2"
          >
            <code className="min-w-0 break-all text-xs">{path}</code>
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => void removePath(path)}
              aria-label={translate('worktreeCopies.remove', 'Remove {{path}}', { path })}
            >
              <X className="size-3" />
            </Button>
          </div>
        ))}
        <WorktreeCopyProjectPaths repo={repo} />
      </div>
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          {translate(
            'worktreeCopies.summary',
            'Both lists are copied together. Fast copying is automatic.'
          )}
        </p>
        <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
            {translate('worktreeCopies.details', 'How copying works')}
          </summary>
          <div className="mt-2 space-y-2 pl-4">
            <p className="break-all">
              {translate('worktreeCopies.source', 'Source: {{path}}', { path: repo.path })}
            </p>
            <p>
              {translate(
                'worktreeCopies.behavior',
                'Only future worktrees are affected. Copies use copy-on-write when available, or ordinary copying otherwise. They never fall back to shared links.'
              )}
            </p>
            <p>
              {translate(
                'worktreeCopies.limits',
                'Ordinary copying is limited to 2 GiB; all copies share a 50,000-entry limit. Use setup to install larger dependencies. Links inside copied folders keep their targets.'
              )}
            </p>
          </div>
        </details>
      </div>
      <WorktreeLegacyPaths repo={repo} updateRepo={updateRepo} />
    </SearchableSetting>
  )
}
