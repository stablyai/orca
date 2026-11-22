import { Copy, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import { FixtureCodeBackdrop } from '../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from './context-menu'

export const open = defineFixture({
  width: 520,
  render: () => (
    <div className="relative h-[340px] overflow-hidden bg-background">
      <FixtureCodeBackdrop />
      <ContextMenu>
        <ContextMenuTrigger className="absolute inset-0" />
        <ContextMenuContent>
          <ContextMenuLabel inset>Worktree</ContextMenuLabel>
          <ContextMenuItem>
            <FolderOpen />
            Open in Finder
          </ContextMenuItem>
          <ContextMenuItem>
            <Copy />
            Copy Path
            <ContextMenuShortcut>⌥⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled>
            <Pencil />
            Rename
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub open>
            <ContextMenuSubTrigger inset>Move to</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>New Window</ContextMenuItem>
              <ContextMenuItem>Split Right</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">
            <Trash2 />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  ),
  interact: (frame) => {
    frame
      .querySelector('[data-slot=context-menu-trigger]')
      ?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 16, clientY: 8 })
      )
  }
})
