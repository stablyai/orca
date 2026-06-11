import { useCallback, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { ChevronRight, FolderOpen, Pencil, Palette, X } from 'lucide-react'
import type { TabFolderGroup } from '../../../../shared/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { TAB_GROUP_COLORS } from './tab-color-palette'
import { translate } from '@/i18n/i18n'
import { getTabFolderGroupDroppableId } from '../tab-group/useTabDragSplit'

type TabFolderGroupChipProps = {
  group: TabFolderGroup
  memberCount: number
  onToggleCollapsed: () => void
  onRename: (name: string) => void
  onChangeColor: (color: string) => void
  onUngroup: () => void
  onCloseAll: () => void
}

export function TabFolderGroupChip({
  group,
  memberCount,
  onToggleCollapsed,
  onRename,
  onChangeColor,
  onUngroup,
  onCloseAll
}: TabFolderGroupChipProps): React.JSX.Element {
  const [isRenaming, setIsRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [renameValue, setRenameValue] = useState(group.name)
  const renameFrameRef = useRef<number | null>(null)
  const { setNodeRef, isOver } = useDroppable({
    id: getTabFolderGroupDroppableId(group.id),
    data: {
      kind: 'folder-group',
      worktreeId: group.worktreeId,
      groupId: group.splitGroupId,
      folderGroupId: group.id
    }
  })

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed) {
      onRename(trimmed)
    }
    setIsRenaming(false)
  }, [onRename, renameValue])

  const setRenameInputElement = useCallback((input: HTMLInputElement | null) => {
    if (renameFrameRef.current !== null) {
      cancelAnimationFrame(renameFrameRef.current)
      renameFrameRef.current = null
    }
    if (!input) {
      return
    }
    // Why: Radix menu focus restoration can race the inline input mount.
    renameFrameRef.current = requestAnimationFrame(() => {
      renameFrameRef.current = null
      input.focus()
      input.select()
    })
  }, [])

  const chip = (
    <button
      type="button"
      className="mx-1 my-auto inline-flex h-6 max-w-[160px] shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 text-xs font-medium text-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ borderColor: group.color }}
      aria-label={translate(
        'auto.components.tab.bar.TabFolderGroupChip.toggle',
        '{{value0}} tab group, {{value1}} tabs',
        { value0: group.name, value1: String(memberCount) }
      )}
      onClick={onToggleCollapsed}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: group.color }} />
      <ChevronRight
        className={`size-3 text-muted-foreground transition-transform ${
          group.collapsed ? '' : 'rotate-90'
        }`}
        aria-hidden
      />
      {isRenaming ? (
        <Input
          ref={setRenameInputElement}
          value={renameValue}
          className="h-5 w-[72px] min-w-[72px] max-w-[92px] rounded-sm bg-input/60 px-1 py-0 text-xs"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setIsRenaming(false)
            }
          }}
        />
      ) : (
        <span className="truncate">{group.name}</span>
      )}
      <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
        {memberCount}
      </span>
    </button>
  )

  return (
    <>
      <div
        ref={setNodeRef}
        className={isOver ? 'bg-accent/40' : undefined}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        {chip}
      </div>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52" sideOffset={0} align="start">
          <DropdownMenuItem onSelect={onToggleCollapsed}>
            <FolderOpen className="mr-1.5 size-3.5" />
            {group.collapsed
              ? translate('auto.components.tab.bar.TabFolderGroupChip.expand', 'Expand Group')
              : translate('auto.components.tab.bar.TabFolderGroupChip.collapse', 'Collapse Group')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setRenameValue(group.name)
              setIsRenaming(true)
            }}
          >
            <Pencil className="mr-1.5 size-3.5" />
            {translate('auto.components.tab.bar.TabFolderGroupChip.rename', 'Rename Group')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="px-2 pt-1.5 pb-1">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Palette className="size-3.5" />
              {translate('auto.components.tab.bar.TabFolderGroupChip.color', 'Group Color')}
            </div>
            <div className="flex flex-wrap gap-2">
              {TAB_GROUP_COLORS.map((color) => (
                <DropdownMenuItem
                  key={color.value}
                  className={`h-4 w-4 min-w-4 rounded-full border border-transparent p-0 ${
                    group.color === color.value
                      ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover'
                      : ''
                  }`}
                  style={{ backgroundColor: color.value }}
                  onSelect={() => onChangeColor(color.value)}
                />
              ))}
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onUngroup}>
            {translate('auto.components.tab.bar.TabFolderGroupChip.ungroup', 'Ungroup')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onCloseAll}>
            <X className="mr-1.5 size-3.5" />
            {translate('auto.components.tab.bar.TabFolderGroupChip.closeAll', 'Close Group Tabs')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
