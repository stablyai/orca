import React, { useMemo, useState } from 'react'
import { ArrowUpRight, Minus, Plus, Trash, Undo2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type {
  GitBranchChangeEntry,
  GitStatusEntry,
  SourceControlViewMode
} from '../../../../shared/types'
import {
  InlineFileRow,
  InlineSectionHeader,
  InlineTreeDirectoryRow,
  sectionLabel
} from './folder-source-control-inline-rows'
import {
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  type SourceControlTreeArea,
  type SourceControlTreeNode
} from './source-control-tree'
import {
  canDiscardStatusEntry,
  canStageStatusEntry,
  canUnstageStatusEntry
} from './source-control-entry-actions'

type InlineChangeEntry = GitStatusEntry | GitBranchChangeEntry
type InlineRowActions = {
  canStage: boolean
  canUnstage: boolean
  canDiscard: boolean
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
}

/** Builds per-row inline actions from shared eligibility rules. */
function statusRowActions(
  entry: GitStatusEntry,
  onStageEntry: (entry: GitStatusEntry) => void,
  onUnstageEntry: (entry: GitStatusEntry) => void,
  onDiscardEntry: (entry: GitStatusEntry) => void
): InlineRowActions {
  return {
    canStage: canStageStatusEntry(entry),
    canUnstage: canUnstageStatusEntry(entry),
    canDiscard: canDiscardStatusEntry(entry),
    /** Stages the entry from its row action. */
    onStage: () => onStageEntry(entry),
    /** Unstages the entry from its row action. */
    onUnstage: () => onUnstageEntry(entry),
    /** Discards the entry from its row action. */
    onDiscard: () => onDiscardEntry(entry)
  }
}

/** Renders a tree/list of source-control entries for one section. */
function renderTreeNodes<Entry extends InlineChangeEntry, Area extends string>(
  nodes: readonly SourceControlTreeNode<Entry, Area>[],
  collapsed: ReadonlySet<string>,
  onToggleDirectory: (key: string) => void,
  onOpenFile: (entry: Entry) => void,
  getActions?: (entry: Entry) => InlineRowActions
): React.ReactNode[] {
  return flattenSourceControlTree([...nodes], collapsed).map((node) => {
    if (node.type === 'directory') {
      return (
        <InlineTreeDirectoryRow
          key={node.key}
          name={node.name}
          fileCount={node.fileCount}
          depth={node.depth}
          isCollapsed={collapsed.has(node.key)}
          onToggle={() => onToggleDirectory(node.key)}
        />
      )
    }
    return (
      <InlineFileRow
        key={node.key}
        path={node.entry.path}
        status={node.entry.status}
        added={node.entry.added}
        removed={node.entry.removed}
        depth={node.depth}
        onOpen={() => onOpenFile(node.entry)}
        {...(getActions ? getActions(node.entry) : {})}
      />
    )
  })
}

/** Renders folder source-control file sections in list or tree mode. */
export function FolderSourceControlSections({
  groupedEntries,
  branchEntries,
  collapsedSections,
  viewMode,
  onToggleSection,
  onOpenEntry,
  onOpenBranchEntry,
  onStageEntry,
  onUnstageEntry,
  onDiscardEntry,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  onViewAll
}: {
  groupedEntries: Record<'staged' | 'unstaged' | 'untracked', GitStatusEntry[]>
  branchEntries: GitBranchChangeEntry[]
  collapsedSections: ReadonlySet<string>
  viewMode: SourceControlViewMode
  onToggleSection: (id: string) => void
  onOpenEntry: (entry: GitStatusEntry) => void
  onOpenBranchEntry: (entry: GitBranchChangeEntry) => void
  onStageEntry: (entry: GitStatusEntry) => void
  onUnstageEntry: (entry: GitStatusEntry) => void
  onDiscardEntry: (entry: GitStatusEntry) => void
  onStageAll: (area: 'unstaged' | 'untracked') => void
  onUnstageAll: (area: 'staged') => void
  onDiscardAll: (area: 'unstaged' | 'untracked') => void
  onViewAll: (area: 'staged' | 'unstaged' | 'untracked') => void
}): React.JSX.Element {
  const [collapsedTreeDirs, setCollapsedTreeDirs] = useState<Set<string>>(() => new Set())
  const treeRootsByArea = useMemo(() => {
    const roots: Record<
      'staged' | 'unstaged' | 'untracked',
      SourceControlTreeNode<GitStatusEntry, SourceControlTreeArea>[]
    > = {
      staged: [],
      unstaged: [],
      untracked: []
    }
    for (const area of ['staged', 'unstaged', 'untracked'] as const) {
      roots[area] = compactSourceControlTree(
        buildGitStatusSourceControlTree(area, groupedEntries[area])
      )
    }
    return roots
  }, [groupedEntries])
  const branchTreeRoots = useMemo(
    () => compactSourceControlTree(buildSourceControlTree('branch', branchEntries)),
    [branchEntries]
  )

  /** Toggles whether a tree directory is collapsed. */
  const toggleTreeDirectory = (key: string): void => {
    setCollapsedTreeDirs((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  return (
    <>
      {(['unstaged', 'staged', 'untracked'] as const).map((area) => {
        const entries = groupedEntries[area]
        if (entries.length === 0) {
          return null
        }
        const collapsed = collapsedSections.has(area)
        return (
          <div key={area}>
            <InlineSectionHeader
              label={sectionLabel(area)}
              count={entries.length}
              isCollapsed={collapsed}
              onToggle={() => onToggleSection(area)}
              actions={
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 px-1 text-[10px] text-muted-foreground hover:text-foreground"
                  aria-label={translate(
                    'auto.components.right.sidebar.SourceControl.48db37cca9',
                    'View all'
                  )}
                  onClick={() => onViewAll(area)}
                >
                  <ArrowUpRight className="size-3" />
                  {translate('auto.components.right.sidebar.SourceControl.48db37cca9', 'View all')}
                </button>
              }
              hoverActions={
                <>
                  {area !== 'staged' ? (
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={translate(
                        'auto.components.right.sidebar.SourceControl.ce41708855',
                        'Discard all'
                      )}
                      onClick={() => onDiscardAll(area)}
                    >
                      {area === 'untracked' ? (
                        <Trash className="size-3" />
                      ) : (
                        <Undo2 className="size-3" />
                      )}
                    </button>
                  ) : null}
                  {area === 'staged' ? (
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={translate(
                        'auto.components.right.sidebar.SourceControl.9339382454',
                        'Unstage all'
                      )}
                      onClick={() => onUnstageAll(area)}
                    >
                      <Minus className="size-3" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={translate(
                        'auto.components.right.sidebar.SourceControl.24d2598eff',
                        'Stage all'
                      )}
                      onClick={() => onStageAll(area)}
                    >
                      <Plus className="size-3" />
                    </button>
                  )}
                </>
              }
            />
            {!collapsed
              ? viewMode === 'tree'
                ? renderTreeNodes(
                    treeRootsByArea[area],
                    collapsedTreeDirs,
                    toggleTreeDirectory,
                    onOpenEntry as (entry: GitStatusEntry) => void,
                    (entry) => statusRowActions(entry, onStageEntry, onUnstageEntry, onDiscardEntry)
                  )
                : entries.map((entry) => (
                    <InlineFileRow
                      key={`${entry.area}:${entry.path}`}
                      path={entry.path}
                      status={entry.status}
                      added={entry.added}
                      removed={entry.removed}
                      onOpen={() => onOpenEntry(entry)}
                      {...statusRowActions(entry, onStageEntry, onUnstageEntry, onDiscardEntry)}
                    />
                  ))
              : null}
          </div>
        )
      })}

      {branchEntries.length > 0 ? (
        <div>
          <InlineSectionHeader
            label={translate(
              'auto.components.right.sidebar.SourceControl.d7ae61269b',
              'Committed on Branch'
            )}
            count={branchEntries.length}
            isCollapsed={collapsedSections.has('branch')}
            onToggle={() => onToggleSection('branch')}
          />
          {!collapsedSections.has('branch')
            ? viewMode === 'tree'
              ? renderTreeNodes(
                  branchTreeRoots,
                  collapsedTreeDirs,
                  toggleTreeDirectory,
                  onOpenBranchEntry as (entry: GitBranchChangeEntry) => void
                )
              : branchEntries.map((entry) => (
                  <InlineFileRow
                    key={`branch:${entry.path}`}
                    path={entry.path}
                    status={entry.status}
                    added={entry.added}
                    removed={entry.removed}
                    onOpen={() => onOpenBranchEntry(entry)}
                  />
                ))
            : null}
        </div>
      ) : null}
    </>
  )
}
