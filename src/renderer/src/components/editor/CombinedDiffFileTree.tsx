import React from 'react'
import { Check, Filter, PanelLeftClose, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree
} from '@/components/right-sidebar/source-control-tree'
import type { GitBranchChangeEntry, GitStagingArea, GitStatusEntry } from '../../../../shared/types'
import {
  getEntryExtension,
  getFilteredCombinedDiffFileTreeEntries,
  isGitStatusEntry,
  type CombinedDiffBranchTreeArea,
  type CombinedDiffFileTreeEntry,
  type CombinedDiffFileTreeMode
} from './combined-diff-file-tree-model'
import { CombinedDiffFileTreeRow, type CombinedDiffTreeNode } from './combined-diff-file-tree-row'
import { translate } from '@/i18n/i18n'

export {
  createCombinedDiffSectionIndexMap,
  getCombinedDiffFileTreeNavigationIndex,
  getCombinedDiffFileTreeSectionKey,
  handleCombinedDiffFileTreeNavigation
} from './combined-diff-file-tree-model'

const UNCOMMITTED_AREA_ORDER: readonly GitStagingArea[] = ['unstaged', 'staged', 'untracked']
const UNCOMMITTED_AREA_LABELS: Record<GitStagingArea, string> = {
  unstaged: 'Changes',
  staged: 'Staged Changes',
  untracked: 'Untracked Files'
}

function buildUncommittedRows(
  entries: readonly CombinedDiffFileTreeEntry[],
  collapsedDirectoryKeys: ReadonlySet<string>
): { area: GitStagingArea; label: string; rows: CombinedDiffTreeNode[] }[] {
  return UNCOMMITTED_AREA_ORDER.map((area) => {
    const areaEntries = entries.filter(
      (entry): entry is GitStatusEntry => isGitStatusEntry(entry) && entry.area === area
    )
    if (areaEntries.length === 0) {
      return null
    }

    const roots = compactSourceControlTree(buildGitStatusSourceControlTree(area, areaEntries))
    return {
      area,
      label: UNCOMMITTED_AREA_LABELS[area],
      rows: flattenSourceControlTree(roots, collapsedDirectoryKeys) as CombinedDiffTreeNode[]
    }
  }).filter(
    (group): group is { area: GitStagingArea; label: string; rows: CombinedDiffTreeNode[] } =>
      Boolean(group)
  )
}

function buildBranchRows(
  mode: Extract<CombinedDiffFileTreeMode, 'all' | 'branch' | 'commit'>,
  entries: readonly CombinedDiffFileTreeEntry[],
  collapsedDirectoryKeys: ReadonlySet<string>
): CombinedDiffTreeNode[] {
  const branchEntries = entries.filter(
    (entry): entry is GitBranchChangeEntry => !isGitStatusEntry(entry)
  )
  const area: CombinedDiffBranchTreeArea = mode === 'commit' ? 'combined-commit' : 'combined-branch'
  const roots = compactSourceControlTree(buildSourceControlTree(area, branchEntries))
  return flattenSourceControlTree(roots, collapsedDirectoryKeys) as CombinedDiffTreeNode[]
}

export function CombinedDiffFileTree({
  mode,
  worktreePath,
  entries,
  sectionIndexByKey,
  activeSectionKey,
  viewedSectionKeys,
  collapsed,
  onCollapsedChange,
  onNavigate
}: {
  mode: CombinedDiffFileTreeMode
  worktreePath: string
  entries: readonly CombinedDiffFileTreeEntry[]
  sectionIndexByKey: ReadonlyMap<string, number>
  activeSectionKey: string | null
  viewedSectionKeys: ReadonlySet<string>
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onNavigate: (entry: CombinedDiffFileTreeEntry) => void
}): React.JSX.Element | null {
  const [collapsedDirectoryKeys, setCollapsedDirectoryKeys] = React.useState<Set<string>>(
    () => new Set()
  )
  const [query, setQuery] = React.useState('')
  const [excludedExtensions, setExcludedExtensions] = React.useState<Set<string>>(() => new Set())
  const [includeViewed, setIncludeViewed] = React.useState(true)
  const toggleDirectory = React.useCallback((key: string) => {
    setCollapsedDirectoryKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const availableExtensions = React.useMemo(
    () => Array.from(new Set(entries.map(getEntryExtension))).sort(),
    [entries]
  )
  const filteredEntries = React.useMemo(
    () =>
      getFilteredCombinedDiffFileTreeEntries({
        entries,
        mode,
        query,
        excludedExtensions,
        includeViewed,
        viewedSectionKeys
      }),
    [entries, excludedExtensions, includeViewed, mode, query, viewedSectionKeys]
  )
  const toggleExtension = React.useCallback((extension: string) => {
    setExcludedExtensions((prev) => {
      const next = new Set(prev)
      if (next.has(extension)) {
        next.delete(extension)
      } else {
        next.add(extension)
      }
      return next
    })
  }, [])
  const resetFilters = React.useCallback(() => {
    setQuery('')
    setExcludedExtensions(new Set())
    setIncludeViewed(true)
  }, [])
  const activeFilterCount =
    excludedExtensions.size + (includeViewed ? 0 : 1) + (query.trim().length > 0 ? 1 : 0)

  const uncommittedGroups = React.useMemo(
    () =>
      mode === 'all' || mode === 'uncommitted'
        ? buildUncommittedRows(filteredEntries, collapsedDirectoryKeys)
        : [],
    [collapsedDirectoryKeys, filteredEntries, mode]
  )
  const branchRows = React.useMemo(
    () =>
      mode === 'all' || mode === 'branch' || mode === 'commit'
        ? buildBranchRows(mode, filteredEntries, collapsedDirectoryKeys)
        : [],
    [collapsedDirectoryKeys, filteredEntries, mode]
  )

  if (collapsed) {
    return null
  }

  return (
    // Why: this column must be height-bounded so the file list, not the page,
    // owns overflow when review diffs have more files than fit on screen.
    <aside className="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-background">
      <div className="sticky top-0 z-20 shrink-0 bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate('auto.components.editor.CombinedDiffFileTree.481e63ca52', 'Files')}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.editor.CombinedDiffFileTree.21783df79f',
              'Collapse file tree'
            )}
            onClick={() => onCollapsedChange(true)}
          >
            <PanelLeftClose className="size-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2 border-b border-border px-2 py-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate(
                'auto.components.editor.CombinedDiffFileTree.4cc7b83ffe',
                'Filter files...'
              )}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.editor.CombinedDiffFileTree.cd0e0ed79e',
                  'Filter diff files'
                )}
                className={cn(activeFilterCount > 0 && 'border-foreground/30 text-foreground')}
              >
                <Filter className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" side="bottom" sideOffset={6} className="w-56 p-0">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
                {translate(
                  'auto.components.editor.CombinedDiffFileTree.c00020f081',
                  'File extensions'
                )}
              </div>
              <div className="max-h-60 overflow-auto py-1 scrollbar-sleek">
                {availableExtensions.map((extension) => {
                  const checked = !excludedExtensions.has(extension)
                  return (
                    <button
                      key={extension}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                      onClick={() => toggleExtension(extension)}
                    >
                      <Check
                        className={cn('size-3.5 shrink-0', checked ? 'opacity-100' : 'opacity-0')}
                      />
                      <span className="min-w-0 flex-1 truncate">{extension}</span>
                    </button>
                  )
                })}
              </div>
              <div className="border-t border-border py-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setIncludeViewed((prev) => !prev)}
                >
                  <Check
                    className={cn('size-3.5 shrink-0', includeViewed ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {translate(
                      'auto.components.editor.CombinedDiffFileTree.be119cb9d1',
                      'Viewed files'
                    )}
                  </span>
                </button>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={resetFilters}
                  >
                    {translate(
                      'auto.components.editor.CombinedDiffFileTree.eafe1aeb53',
                      'Reset filters'
                    )}
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 scrollbar-sleek">
        {filteredEntries.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.editor.CombinedDiffFileTree.f984289373',
              'No files match the current filters.'
            )}
          </div>
        ) : mode === 'all' || mode === 'uncommitted' ? (
          <>
            {uncommittedGroups.map((group) => (
              <div key={group.area} className="py-1">
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {group.label}
                </div>
                {group.rows.map((node) => (
                  <CombinedDiffFileTreeRow
                    key={node.key}
                    node={node}
                    mode={mode}
                    worktreePath={worktreePath}
                    activeSectionKey={activeSectionKey}
                    sectionIndexByKey={sectionIndexByKey}
                    isCollapsed={collapsedDirectoryKeys.has(node.key)}
                    onToggleDirectory={toggleDirectory}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            ))}
            {mode === 'all' && branchRows.length > 0 ? (
              <div className="py-1">
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {translate(
                    'auto.components.editor.CombinedDiffFileTree.39b6b9e4e4',
                    'Committed on Branch'
                  )}
                </div>
                {branchRows.map((node) => (
                  <CombinedDiffFileTreeRow
                    key={node.key}
                    node={node}
                    mode={mode}
                    worktreePath={worktreePath}
                    activeSectionKey={activeSectionKey}
                    sectionIndexByKey={sectionIndexByKey}
                    isCollapsed={collapsedDirectoryKeys.has(node.key)}
                    onToggleDirectory={toggleDirectory}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          branchRows.map((node) => (
            <CombinedDiffFileTreeRow
              key={node.key}
              node={node}
              mode={mode}
              worktreePath={worktreePath}
              activeSectionKey={activeSectionKey}
              sectionIndexByKey={sectionIndexByKey}
              isCollapsed={collapsedDirectoryKeys.has(node.key)}
              onToggleDirectory={toggleDirectory}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
    </aside>
  )
}
