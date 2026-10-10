import { ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Checkbox } from './ui/checkbox'

/** Indent per tree level, right of the shared checkbox column. */
const RESUME_TREE_INDENT_PX = 18

/** Width of the checkbox column (w-7). */
const RESUME_TREE_CHECKBOX_COLUMN_PX = 28

/** Where a row's body starts: the checkbox column, the arrow slot (size-4.5) and the body's pl-1. */
const RESUME_TREE_BODY_OFFSET_PX = RESUME_TREE_CHECKBOX_COLUMN_PX + 18 + 4

/**
 * One row of the resume tree: the checkbox in the list's single left column, the indent for its
 * depth, a disclosure arrow (an empty slot on a leaf, so icons line up), then the caller's body.
 *
 * The row is a flat `treeitem` carrying its own `aria-level`, so the tree's keyboard handling can
 * find a row's disclosure without walking nested groups.
 */
export function ResumeTreeRow({
  depth,
  expanded,
  onExpandedChange,
  name,
  checked,
  disabled,
  onCheckedChange,
  checkboxLabel,
  checkboxSlot,
  compact = false,
  trailing,
  below,
  children
}: {
  depth: number
  /** Absent on a leaf; a node with children is open or closed. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Names the node in its disclosure's label. */
  name: string
  checked: boolean | 'indeterminate'
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  checkboxLabel: string
  /** A run status replaces this leaf's checkbox in the same column. */
  checkboxSlot?: React.ReactNode
  /** A chat row sits a little tighter than a group row. */
  compact?: boolean
  /** Controls beside the row that must not toggle its checkbox. */
  trailing?: React.ReactNode
  /** A line under the row, aligned with its body. */
  below?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const indent = depth * RESUME_TREE_INDENT_PX
  const Content = checkboxSlot ? 'div' : 'label'
  return (
    <div role="treeitem" aria-level={depth + 1} aria-expanded={expanded} className="flex flex-col">
      <div className="group/row relative flex min-w-0 items-center gap-1">
        <Content
          data-compact={compact}
          data-status={Boolean(checkboxSlot)}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center rounded-md pr-2.5 group-hover/row:bg-worktree-sidebar-accent has-[:disabled]:cursor-default data-[compact=true]:h-6.5 data-[status=true]:cursor-default"
        >
          <span className="flex w-7 shrink-0 justify-center">
            {checkboxSlot ?? (
              <Checkbox
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => onCheckedChange(next === true)}
                aria-label={checkboxLabel}
              />
            )}
          </span>
          <span aria-hidden="true" className="shrink-0" style={{ width: indent }} />
          {/* The arrow's slot, kept on a leaf too so icons line up. */}
          <span aria-hidden="true" className="size-4.5 shrink-0" />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">{children}</span>
        </Content>
        {expanded !== undefined && (
          // Laid over its slot rather than inside the label, so pressing it never toggles the
          // checkbox. Off the tab order: Left/Right on the row's checkbox do the same.
          <button
            type="button"
            tabIndex={-1}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? translate(
                    'auto.components.NativeChatResumeOnRestartModal.collapseNode',
                    'Collapse {{value0}}',
                    { value0: name }
                  )
                : translate(
                    'auto.components.NativeChatResumeOnRestartModal.expandNode',
                    'Expand {{value0}}',
                    { value0: name }
                  )
            }
            onClick={(event) => {
              onExpandedChange?.(!expanded)
              // A pointer press focuses the arrow, where no tree key works; hand focus to the
              // row's checkbox, or to the tree when that is disabled.
              const row = event.currentTarget.closest('[role="treeitem"]')
              const box = row?.querySelector<HTMLElement>('[role="checkbox"]:not(:disabled)')
              const next = box ?? row?.closest<HTMLElement>('[role="tree"]')
              next?.focus()
            }}
            className="group/disclosure absolute top-1/2 flex size-4.5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/8"
            style={{ left: RESUME_TREE_CHECKBOX_COLUMN_PX + indent }}
          >
            <ChevronRight className="size-3 transition-transform group-aria-expanded/disclosure:rotate-90 motion-reduce:transition-none" />
          </button>
        )}
        {trailing}
      </div>
      {below && (
        <div className="pr-2.5" style={{ paddingLeft: RESUME_TREE_BODY_OFFSET_PX + indent }}>
          {below}
        </div>
      )}
    </div>
  )
}

/** A group node's "x of y" on the right of its row. */
export function ResumeTreeCount({
  selectedCount,
  total
}: {
  selectedCount: number
  total: number
}): React.JSX.Element | null {
  if (total === 0) {
    return null
  }
  return (
    <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
      {translate(
        'auto.components.NativeChatResumeOnRestartModal.workspaceSelectedCount',
        '{{value0}} of {{value1}}',
        { value0: selectedCount, value1: total }
      )}
    </span>
  )
}
