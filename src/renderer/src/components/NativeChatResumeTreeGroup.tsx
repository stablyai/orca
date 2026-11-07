import { useContext } from 'react'
import { ResumeTreeRow, ResumeTreeCount } from './NativeChatResumeTreeRow'
import { ResumeTreeSelectingContext, type TreeProps } from './native-chat-resume-tree-state'
import {
  resumeSelectionState,
  toggleResumeSelection
} from './native-chat-resume-on-restart-grouping'

export function ResumeTreeGroup({
  nodeKey,
  depth,
  name,
  checkboxLabel,
  covered,
  tree,
  label,
  children
}: {
  nodeKey: string
  depth: number
  name: string
  checkboxLabel: string
  /** Every selectable chat under this node. */
  covered: readonly string[]
  tree: TreeProps
  label: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const selection = resumeSelectionState(covered, tree.selected)
  const expanded = tree.isExpanded(nodeKey)
  const selecting = useContext(ResumeTreeSelectingContext)
  return (
    <>
      <ResumeTreeRow
        depth={depth}
        expanded={expanded}
        onExpandedChange={(next) => tree.setExpanded(nodeKey, next)}
        name={name}
        checked={selection.checked}
        disabled={tree.busy || selection.total === 0}
        onCheckedChange={() => toggleResumeSelection(covered, selection, tree.onToggle)}
        checkboxLabel={checkboxLabel}
      >
        {label}
        {selecting && (
          <ResumeTreeCount selectedCount={selection.selectedCount} total={selection.total} />
        )}
      </ResumeTreeRow>
      {/* Collapsing unmounts the rows only; their selection lives with the dialog. */}
      {expanded && children}
    </>
  )
}
