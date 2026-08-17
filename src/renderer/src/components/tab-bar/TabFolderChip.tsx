import { useCallback, useRef, useState } from 'react'
import { ChevronRight, FolderOpen, FolderX, Pencil } from 'lucide-react'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { TAB_CONTEXT_MENU_CONTENT_CLASS } from './tab-context-menu-sizing'

type TabFolderChipProps = {
  folder: TabFolderGroup
  memberCount: number
}

export function TabFolderChip({ folder, memberCount }: TabFolderChipProps): React.JSX.Element {
  const setCollapsed = useAppStore((state) => state.setTabFolderGroupCollapsed)
  const setName = useAppStore((state) => state.setTabFolderGroupName)
  const ungroup = useAppStore((state) => state.ungroupTabFolderGroup)
  const renamingFolderGroupId = useAppStore((state) => state.renamingFolderGroupId)
  const setRenamingFolderGroupId = useAppStore((state) => state.setRenamingFolderGroupId)
  const isRenaming = renamingFolderGroupId === folder.id
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [renameValue, setRenameValue] = useState(folder.name)
  const renameFrameRef = useRef<number | null>(null)

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed) {
      setName(folder.id, trimmed)
    }
    setRenamingFolderGroupId(null)
  }, [folder.id, renameValue, setName, setRenamingFolderGroupId])

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

  const openContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    setMenuPoint({ x: event.clientX, y: event.clientY })
    setMenuOpen(true)
  }
  const chipClassName =
    'mx-1 my-auto inline-flex h-6 max-w-[160px] shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 text-xs font-medium text-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  const chipChrome = (
    <>
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: folder.color }} />
      <ChevronRight
        className={`size-3 text-muted-foreground transition-transform ${
          folder.collapsed ? '' : 'rotate-90'
        }`}
        aria-hidden
      />
    </>
  )
  const memberBadge = (
    <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
      {memberCount}
    </span>
  )

  return (
    <>
      {isRenaming ? (
        <div
          className={chipClassName}
          style={{ borderColor: folder.color }}
          onContextMenu={openContextMenu}
        >
          {chipChrome}
          <Input
            ref={setRenameInputElement}
            value={renameValue}
            aria-label={translate('components.tab.bar.TabFolderChip.rename', 'Rename folder')}
            className="h-5 w-[72px] min-w-[72px] max-w-[92px] rounded-sm bg-input/60 px-1 py-0 text-xs"
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setRenamingFolderGroupId(null)
              }
            }}
          />
          {memberBadge}
        </div>
      ) : (
        <button
          type="button"
          className={chipClassName}
          style={{ borderColor: folder.color }}
          aria-expanded={!folder.collapsed}
          aria-label={translate(
            'components.tab.bar.TabFolderChip.toggle',
            '{{value0}} folder, {{value1}} tabs',
            { value0: folder.name, value1: String(memberCount) }
          )}
          onClick={() => setCollapsed(folder.id, !folder.collapsed)}
          onContextMenu={openContextMenu}
        >
          {chipChrome}
          <span className="truncate">{folder.name}</span>
          {memberBadge}
        </button>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={TAB_CONTEXT_MENU_CONTENT_CLASS}
          sideOffset={0}
          align="start"
        >
          <DropdownMenuItem onSelect={() => setCollapsed(folder.id, !folder.collapsed)}>
            <FolderOpen className="size-3.5" />
            {folder.collapsed
              ? translate('components.tab.bar.TabFolderChip.expand', 'Expand folder')
              : translate('components.tab.bar.TabFolderChip.collapse', 'Collapse folder')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setRenameValue(folder.name)
              setRenamingFolderGroupId(folder.id)
            }}
          >
            <Pencil className="size-3.5" />
            {translate('components.tab.bar.TabFolderChip.rename', 'Rename folder')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => ungroup(folder.id)}>
            <FolderX className="size-3.5" />
            {translate('components.tab.bar.TabFolderChip.ungroup', 'Ungroup')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
