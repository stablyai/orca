import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { WorkspaceGroupColor, WorkspaceGroupId } from '../../../../shared/types'
import { WORKSPACE_GROUP_COLOR_IDS } from '../../../../shared/workspace-groups'
import { getWorkspaceGroupSwatchClass } from './workspace-status'

type Props = {
  groupId: WorkspaceGroupId
  name: string
  color: WorkspaceGroupColor
  memberCount: number
  collapsed: boolean
  isRenaming?: boolean
  renameDraft?: string
  onToggleCollapsed: (groupId: WorkspaceGroupId) => void
  onRenameDraftChange: (groupId: WorkspaceGroupId, draft: string) => void
  onRenameCommit: (groupId: WorkspaceGroupId, name: string) => void
  onRenameCancel: (groupId: WorkspaceGroupId) => void
  onStartRename: (groupId: WorkspaceGroupId) => void
  onRecolor: (groupId: WorkspaceGroupId, color: WorkspaceGroupColor) => void
  onReorder: (groupId: WorkspaceGroupId, direction: 'up' | 'down') => void
  onUngroup: (groupId: WorkspaceGroupId) => void
}

export function GroupHeaderRow({
  groupId,
  name,
  color,
  memberCount,
  collapsed,
  isRenaming,
  renameDraft,
  onToggleCollapsed,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onStartRename,
  onRecolor,
  onReorder,
  onUngroup
}: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const wasRenamingRef = useRef(Boolean(isRenaming))
  const draft = renameDraft ?? name

  useEffect(() => {
    if (isRenaming && !wasRenamingRef.current) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    wasRenamingRef.current = Boolean(isRenaming)
  }, [isRenaming])

  const Chevron = collapsed ? ChevronRight : ChevronDown

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-2 px-2 py-1 select-none">
          <button
            type="button"
            aria-label={collapsed ? 'Expand group' : 'Collapse group'}
            onClick={() => onToggleCollapsed(groupId)}
            className="opacity-70 hover:opacity-100"
          >
            <Chevron size={14} />
          </button>
          <span
            aria-hidden
            data-testid="workspace-group-color-dot"
            className={`inline-block w-2 h-2 rounded-full ${getWorkspaceGroupSwatchClass(color)}`}
          />
          {isRenaming ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => onRenameDraftChange(groupId, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onRenameCommit(groupId, draft)
                } else if (e.key === 'Escape') {
                  onRenameCancel(groupId)
                }
              }}
              onBlur={() => onRenameCommit(groupId, draft)}
              className="flex-1 bg-transparent border-b border-border focus:outline-none text-sm"
            />
          ) : (
            <span
              role="button"
              tabIndex={0}
              title="Double-click to rename"
              onDoubleClick={() => onStartRename(groupId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'F2') {
                  onStartRename(groupId)
                }
              }}
              className="flex-1 text-sm font-medium truncate cursor-text"
            >
              {name}
            </span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">{memberCount}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onStartRename(groupId)}>Rename</ContextMenuItem>
        <div role="group" aria-label="Change color" className="flex items-center gap-1 px-2 py-1.5">
          {WORKSPACE_GROUP_COLOR_IDS.map((swatchColor) => (
            <button
              key={swatchColor}
              type="button"
              aria-label={`Set color ${swatchColor}`}
              onClick={() => onRecolor(groupId, swatchColor)}
              className={`inline-block w-4 h-4 rounded-full ${getWorkspaceGroupSwatchClass(swatchColor)} ${swatchColor === color ? 'ring-2 ring-offset-1 ring-offset-popover ring-foreground' : 'hover:opacity-80'}`}
            />
          ))}
        </div>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onToggleCollapsed(groupId)}>
          {collapsed ? 'Expand' : 'Collapse'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onReorder(groupId, 'up')}>Move up</ContextMenuItem>
        <ContextMenuItem onSelect={() => onReorder(groupId, 'down')}>Move down</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onUngroup(groupId)}>Ungroup</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
