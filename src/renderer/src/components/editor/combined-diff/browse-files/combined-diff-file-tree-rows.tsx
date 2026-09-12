import React from 'react'
import { SourceControlVirtualFileList } from '@/components/right-sidebar/source-control/listing/virtual-file-list'
import type {
  CombinedDiffFileTreeEntry,
  CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'
import {
  CombinedDiffFileTreeRow,
  COMBINED_DIFF_TREE_ROW_HEIGHT_PX
} from './combined-diff-file-tree-row'
import type { CombinedDiffTreeNode } from './combined-diff-file-tree-model'

/**
 * One flattened tree section, windowed inside the file tree's scroller. A 900-file review flattens
 * to over a thousand rows; below the virtualize threshold the rows stay in natural flow so small
 * diffs keep byte-identical markup.
 */
export function CombinedDiffFileTreeRows({
  rows,
  mode,
  worktreePath,
  activeSectionKey,
  sectionIndexByKey,
  collapsedDirectoryKeys,
  visibleFileCounts,
  scrollElement,
  onToggleDirectory,
  onNavigate
}: {
  rows: readonly CombinedDiffTreeNode[]
  mode: CombinedDiffFileTreeMode
  worktreePath: string
  activeSectionKey: string | null
  sectionIndexByKey: ReadonlyMap<string, number>
  collapsedDirectoryKeys: ReadonlySet<string>
  visibleFileCounts: ReadonlyMap<string, number> | undefined
  scrollElement: HTMLDivElement | null
  onToggleDirectory: (key: string) => void
  onNavigate: (entry: CombinedDiffFileTreeEntry) => void
}): React.JSX.Element {
  return (
    <SourceControlVirtualFileList
      rows={rows}
      scrollElement={scrollElement}
      estimateRowHeightPx={COMBINED_DIFF_TREE_ROW_HEIGHT_PX}
      getRowKey={(node) => node.key}
      renderRow={(node) => (
        <CombinedDiffFileTreeRow
          key={node.key}
          node={node}
          mode={mode}
          worktreePath={worktreePath}
          activeSectionKey={activeSectionKey}
          sectionIndexByKey={sectionIndexByKey}
          isCollapsed={collapsedDirectoryKeys.has(node.key)}
          visibleFileCount={visibleFileCounts?.get(node.key)}
          onToggleDirectory={onToggleDirectory}
          onNavigate={onNavigate}
        />
      )}
    />
  )
}
