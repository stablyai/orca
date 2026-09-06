import React, { useMemo, useState } from 'react'
import { Check, ChevronDown, FolderGit2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { FilterOptionCount } from '../dashboard-popout/FilterOptionCount'
import type { SessionGridFilterOption } from './session-grid-items-builder'
import {
  sessionGridBranchMeta,
  type SessionGridWorktreeCatalog,
  type SessionGridWorktreeEntry
} from './session-grid-worktree-catalog'
import type { SessionGridFilter } from '../../../../shared/session-grid-types'
import { translate } from '@/i18n/i18n'

type ScopeRow = { option: SessionGridFilterOption; entry: SessionGridWorktreeEntry | undefined }
type ScopeGroup = { key: string; repoName: string; rows: ScopeRow[] }

/**
 * Workspaces holding sessions, grouped by project in catalog order. Orca's typical user has
 * a few projects with many worktrees each, so the project is the header and the worktree the
 * row — the sidebar's shape. A workspace the catalog no longer knows gets its own group.
 */
function groupScopeOptions(
  filterOptions: readonly SessionGridFilterOption[],
  worktreeCatalog: SessionGridWorktreeCatalog
): ScopeGroup[] {
  const byKey = new Map<string, ScopeGroup>()
  for (const option of filterOptions) {
    if (option.id === 'all') {
      continue
    }
    const entry = worktreeCatalog.byWorktreeId.get(option.id)
    const key = entry?.repoId ?? `unknown:${option.id}`
    const group = byKey.get(key) ?? { key, repoName: entry?.repoName ?? option.label, rows: [] }
    group.rows.push({ option, entry })
    byKey.set(key, group)
  }
  const ordered: ScopeGroup[] = []
  for (const repo of worktreeCatalog.byRepo) {
    const group = byKey.get(repo.repoId)
    if (group) {
      ordered.push(group)
      byKey.delete(repo.repoId)
    }
  }
  return [...ordered, ...byKey.values()]
}

/**
 * The workspace axis as a scope picker: one button naming what the grid is showing, a
 * searchable, project-grouped list behind it. Replaces one chip per workspace, which grew
 * without bound and scrolled inside a 44 px toolbar. The check sits left with its gutter
 * reserved on every row, as in the app's other Command pickers.
 */
export function SessionGridWorkspacePicker({
  filterOptions,
  activeFilter,
  worktreeCatalog,
  className
}: {
  filterOptions: SessionGridFilterOption[]
  activeFilter: SessionGridFilter
  worktreeCatalog: SessionGridWorktreeCatalog
  className?: string
}): React.JSX.Element {
  const setSessionsGridFilter = useAppStore((s) => s.setSessionsGridFilter)
  const [open, setOpen] = useState(false)
  const groups = useMemo(
    () => groupScopeOptions(filterOptions, worktreeCatalog),
    [filterOptions, worktreeCatalog]
  )
  const allOption = filterOptions.find((option) => option.id === 'all')
  const activeOption = filterOptions.find((option) => option.id === activeFilter)
  const activeEntry =
    activeFilter === 'all' ? undefined : worktreeCatalog.byWorktreeId.get(activeFilter)
  const allLabel = translate(
    'auto.components.session.grid.SessionGridWorkspacePicker.all',
    'All workspaces'
  )

  const select = (id: SessionGridFilter): void => {
    setSessionsGridFilter(id)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          data-testid="session-grid-workspace-picker"
          data-value={activeFilter}
          aria-label={translate(
            'auto.components.session.grid.SessionGridWorkspacePicker.trigger',
            'Workspace: {{value0}}',
            { value0: activeFilter === 'all' ? allLabel : (activeOption?.label ?? allLabel) }
          )}
          className={cn(
            'h-7 max-w-64 gap-1.5 px-2 text-xs border-border/80 bg-background/50 @max-2xl/toolbar:max-w-none',
            className
          )}
        >
          {/* Below 672 px the words go and the icon stands in; the tooltip still names the scope. */}
          <FolderGit2 className="size-3.5 text-muted-foreground @2xl/toolbar:!hidden" />
          <span className="truncate @max-2xl/toolbar:!hidden">
            {activeFilter === 'all' || !activeEntry ? (
              (activeOption?.label ?? allLabel)
            ) : (
              <>
                {activeEntry.worktreeName !== activeEntry.repoName ? (
                  <span className="text-muted-foreground">{activeEntry.repoName} / </span>
                ) : null}
                <span className="font-medium">{activeEntry.worktreeName}</span>
              </>
            )}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground @max-2xl/toolbar:!hidden">
            {activeOption?.count ?? allOption?.count ?? 0}
          </span>
          <ChevronDown className="size-3 text-muted-foreground @max-xl/toolbar:!hidden" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-72 p-0"
        onOpenAutoFocus={(event) => {
          // Radix would focus the content wrapper; the search box is the real target.
          event.preventDefault()
          const content = event.currentTarget
          if (content instanceof HTMLElement) {
            content.querySelector<HTMLInputElement>('[data-slot="command-input"]')?.focus()
          }
        }}
      >
        <Command>
          <CommandInput
            placeholder={translate(
              'auto.components.session.grid.SessionGridWorkspacePicker.search',
              'Search workspaces…'
            )}
            className="h-8 text-xs"
          />
          <CommandList className="max-h-80">
            <CommandEmpty>
              {translate(
                'auto.components.session.grid.SessionGridWorkspacePicker.empty',
                'No workspace matches'
              )}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="all"
                keywords={[allLabel]}
                data-testid="session-grid-workspace-option"
                data-value="all"
                onSelect={() => select('all')}
                className="text-xs"
              >
                <Check className={cn('size-3.5 shrink-0', activeFilter !== 'all' && 'opacity-0')} />
                <span className="truncate">{allLabel}</span>
                <FilterOptionCount count={allOption?.count ?? 0} />
              </CommandItem>
            </CommandGroup>
            {groups.length > 0 ? <CommandSeparator /> : null}
            {groups.map((group) => (
              <CommandGroup key={group.key} heading={group.repoName}>
                {group.rows.map(({ option, entry }) => {
                  const branch = sessionGridBranchMeta(entry)
                  const isActive = activeFilter === option.id
                  return (
                    <CommandItem
                      key={option.id}
                      value={option.id}
                      keywords={[group.repoName, entry?.worktreeName ?? option.label, branch ?? '']}
                      data-testid="session-grid-workspace-option"
                      data-value={option.id}
                      onSelect={() => select(option.id)}
                      className="text-xs"
                    >
                      <Check className={cn('size-3.5 shrink-0', !isActive && 'opacity-0')} />
                      <span className="truncate font-medium">
                        {entry?.worktreeName ?? option.label}
                      </span>
                      {branch ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          · {branch}
                        </span>
                      ) : null}
                      {entry?.hostLabel ? (
                        <span className="ml-auto truncate pl-2 text-[10px] text-muted-foreground">
                          {entry.hostLabel}
                        </span>
                      ) : null}
                      <FilterOptionCount count={option.count} />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
