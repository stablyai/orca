import React from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getRuntimeGitRemoteFileUrl } from '@/runtime/runtime-git-client'
import { formatPathLineReference } from './line-copy-path'

type MonacoGutterContextMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  point: { x: number; y: number }
  line: number
  filePath: string
  relativePath: string
}

export function MonacoGutterContextMenu({
  open,
  onOpenChange,
  point,
  line,
  filePath,
  relativePath
}: MonacoGutterContextMenuProps): React.JSX.Element {
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
      <DropdownMenuContent sideOffset={0} align="start">
        <DropdownMenuItem
          onSelect={() => window.api.ui.writeClipboardText(formatPathLineReference(filePath, line))}
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          Copy Path to Line
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            window.api.ui.writeClipboardText(formatPathLineReference(relativePath, line))
          }
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          Copy Rel. Path to Line
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            const state = useAppStore.getState()
            const activeFile = state.openFiles.find((f) => f.filePath === filePath)
            if (!activeFile) {
              return
            }
            const worktree = findWorktreeById(state.worktreesByRepo, activeFile.worktreeId)
            if (!worktree) {
              return
            }
            const connectionId = getConnectionId(activeFile?.worktreeId ?? null) ?? undefined
            const url = await getRuntimeGitRemoteFileUrl(
              {
                settings: state.settings,
                worktreeId: activeFile.worktreeId,
                worktreePath: worktree.path,
                connectionId
              },
              { relativePath, line }
            )
            if (url) {
              window.api.ui.writeClipboardText(url)
            }
          }}
        >
          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
          Copy Remote URL
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
