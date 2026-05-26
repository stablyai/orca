/* eslint-disable max-lines -- Why: the combined diff tree keeps filtering,
directory rows, file rows, drag metadata, and navigation wiring together so
the row contracts stay local to the surface. */
import React from 'react'
import {
  Check,
  ChevronDown,
  Filter,
  Folder,
  FolderOpen,
  PanelLeftClose,
  Search
} from 'lucide-react'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  type SourceControlTreeNode
} from '@/components/right-sidebar/source-control-tree'
import { STATUS_COLORS, STATUS_LABELS } from '@/components/right-sidebar/status-display'
import type {
  GitBranchChangeEntry,
  GitFileStatus,
  GitStagingArea,
  GitStatusEntry
} from '../../../../shared/types'
import {
  getCombinedDiffFileTreeSectionKey,
  getEntryExtension,
  getFilteredCombinedDiffFileTreeEntries,
  isGitStatusEntry,
  type CombinedDiffBranchTreeArea,
  type CombinedDiffFileTreeEntry,
  type CombinedDiffFileTreeMode
} from './combined-diff-file-tree-model'

export {
  createCombinedDiffSectionIndexMap,
  getCombinedDiffFileTreeNavigationIndex,
  getCombinedDiffFileTreeSectionKey,
  handleCombinedDiffFileTreeNavigation
} from './combined-diff-file-tree-model'

type CombinedDiffTreeNode = SourceControlTreeNode<
  GitStatusEntry | GitBranchChangeEntry,
  GitStagingArea | CombinedDiffBranchTreeArea
>

const COMBINED_DIFF_TREE_INDENT_PX = 12
const COMBINED_DIFF_TREE_DIRECTORY_PADDING_PX = 8
const COMBINED_DIFF_TREE_FILE_PADDING_PX = 20
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
  mode: Extract<CombinedDiffFileTreeMode, 'branch' | 'commit'>,
  entries: readonly CombinedDiffFileTreeEntry[],
  collapsedDirectoryKeys: ReadonlySet<string>
): CombinedDiffTreeNode[] {
  const branchEntries = entries.filter(
    (entry): entry is GitBranchChangeEntry => !isGitStatusEntry(entry)
  )
  const area: CombinedDiffBranchTreeArea = mode === 'branch' ? 'combined-branch' : 'combined-commit'
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
      mode === 'uncommitted' ? buildUncommittedRows(filteredEntries, collapsedDirectoryKeys) : [],
    [collapsedDirectoryKeys, filteredEntries, mode]
  )
  const branchRows = React.useMemo(
    () =>
      mode === 'branch' || mode === 'commit'
        ? buildBranchRows(mode, filteredEntries, collapsedDirectoryKeys)
        : [],
    [collapsedDirectoryKeys, filteredEntries, mode]
  )

  if (collapsed) {
    return null
  }

  return (
    <aside className="sticky top-0 flex h-full max-h-full w-64 shrink-0 self-start flex-col border-r border-border bg-background">
      <div className="sticky top-0 z-20 shrink-0 bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Files
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Collapse file tree"
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
              placeholder="Filter files..."
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Filter diff files"
                className={cn(activeFilterCount > 0 && 'border-foreground/30 text-foreground')}
              >
                <Filter className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" side="bottom" sideOffset={6} className="w-56 p-0">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
                File extensions
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
                  <span className="min-w-0 flex-1 truncate">Viewed files</span>
                </button>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={resetFilters}
                  >
                    Reset filters
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
            No files match the current filters.
          </div>
        ) : mode === 'uncommitted' ? (
          uncommittedGroups.map((group) => (
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
          ))
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

function CombinedDiffFileTreeRow({
  node,
  mode,
  worktreePath,
  activeSectionKey,
  sectionIndexByKey,
  isCollapsed,
  onToggleDirectory,
  onNavigate
}: {
  node: CombinedDiffTreeNode
  mode: CombinedDiffFileTreeMode
  worktreePath: string
  activeSectionKey: string | null
  sectionIndexByKey: ReadonlyMap<string, number>
  isCollapsed: boolean
  onToggleDirectory: (key: string) => void
  onNavigate: (entry: CombinedDiffFileTreeEntry) => void
}): React.JSX.Element {
  if (node.type === 'directory') {
    return (
      <div
        className="group relative flex w-full items-center gap-1 py-1 pr-3 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        style={{
          paddingLeft: `${node.depth * COMBINED_DIFF_TREE_INDENT_PX + COMBINED_DIFF_TREE_DIRECTORY_PADDING_PX}px`
        }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, joinPath(worktreePath, node.path))
          event.dataTransfer.effectAllowed = 'copy'
        }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => onToggleDirectory(node.key)}
          aria-expanded={!isCollapsed}
        >
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
          />
          {isCollapsed ? (
            <Folder className="size-3 shrink-0" />
          ) : (
            <FolderOpen className="size-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
        <span className="w-4 shrink-0 text-center text-[10px] font-bold tabular-nums text-muted-foreground/80">
          {node.fileCount}
        </span>
      </div>
    )
  }

  const sectionKey = getCombinedDiffFileTreeSectionKey(mode, node.entry)
  const FileIcon = getFileTypeIcon(node.entry.path)
  const fileName = basename(node.entry.path)
  const parentDir = dirname(node.entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const status = node.entry.status as GitFileStatus
  const disabled = !sectionIndexByKey.has(sectionKey)

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full min-w-0 cursor-pointer items-center gap-1 py-1 pr-3 text-left text-xs transition-colors hover:bg-accent/40 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
        activeSectionKey === sectionKey && 'bg-accent/60'
      )}
      style={{
        paddingLeft: `${node.depth * COMBINED_DIFF_TREE_INDENT_PX + COMBINED_DIFF_TREE_FILE_PADDING_PX}px`
      }}
      disabled={disabled}
      draggable={!disabled}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        event.dataTransfer.setData(
          WORKSPACE_FILE_PATH_MIME,
          joinPath(worktreePath, node.entry.path)
        )
        event.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => onNavigate(node.entry)}
    >
      <FileIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[status] }} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{fileName}</span>
        {dirPath && <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>}
      </span>
      <span
        className="w-4 shrink-0 text-center text-[10px] font-bold"
        style={{ color: STATUS_COLORS[status] }}
      >
        {STATUS_LABELS[status]}
      </span>
    </button>
  )
}
