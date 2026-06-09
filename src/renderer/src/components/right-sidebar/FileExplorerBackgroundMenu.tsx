import React from 'react'
import { FilePlus, FolderPlus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

function stopRightButtonMenuSelection(event: React.PointerEvent): void {
  if (event.button !== 2) {
    return
  }
  // Why: the synthetic trigger sits at the cursor; the right-button release
  // can otherwise land on "New File" and select it immediately.
  event.preventDefault()
  event.stopPropagation()
}

export function FileExplorerBackgroundMenu({
  open,
  onOpenChange,
  point,
  worktreePath,
  onStartNew
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  point: { x: number; y: number }
  worktreePath: string
  onStartNew: (type: 'file' | 'folder', dir: string, depth: number) => void
}): React.JSX.Element {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-px opacity-0"
          style={{ left: point.x, top: point.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-48"
        sideOffset={0}
        align="start"
        onPointerUpCapture={stopRightButtonMenuSelection}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuItem onSelect={() => onStartNew('file', worktreePath, 0)}>
          <FilePlus />
          {translate("auto.components.right.sidebar.FileExplorerBackgroundMenu.21fe46ed36", "New File")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onStartNew('folder', worktreePath, 0)}>
          <FolderPlus />
          {translate("auto.components.right.sidebar.FileExplorerBackgroundMenu.3b5e2dcb8d", "New Folder")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
