import React from 'react'
import type { IRange } from 'monaco-editor'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
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
import { getRuntimeGitRemoteFileUrl } from '@/runtime/runtime-git-working-tree-client'
import { formatPathLineReference } from './line-copy-path'
import { formatClipboardFilePath } from '@/lib/clipboard-file-path'
import { getOpenFileRevealOwner } from '@/lib/reveal-in-file-manager'
import { translate } from '@/i18n/i18n'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { getRemoteUrlLineRange } from './selection-copy'

type MonacoGutterContextMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  point: { x: number; y: number }
  line: number
  selection: IRange | null
  fileId: string
  filePath: string
  relativePath: string
  worktreeId?: string
}

export function MonacoGutterContextMenu({
  open,
  onOpenChange,
  point,
  line,
  selection,
  fileId,
  filePath,
  relativePath,
  worktreeId
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
          onSelect={() => {
            const state = useAppStore.getState()
            const file = state.openFiles.find((openFile) => openFile.id === fileId)
            const owner = file ? getOpenFileRevealOwner(state, file) : 'unresolved'
            void window.api.ui.writeClipboardText(
              formatPathLineReference(formatClipboardFilePath(filePath, owner), line)
            )
          }}
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          {translate(
            'auto.components.editor.MonacoGutterContextMenu.4eaa991bde',
            'Copy Path to Line'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            window.api.ui.writeClipboardText(formatPathLineReference(relativePath, line))
          }
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          {translate(
            'auto.components.editor.MonacoGutterContextMenu.2e0b1cdc05',
            'Copy Rel. Path to Line'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            const state = useAppStore.getState()
            // Conflict overview editors may carry a synthetic id; fall back only within this owner.
            const activeFile =
              state.openFiles.find((file) => file.id === fileId) ??
              (worktreeId
                ? state.openFiles.find(
                    (file) => file.filePath === filePath && file.worktreeId === worktreeId
                  )
                : undefined)
            if (!activeFile) {
              return
            }
            const worktree = findWorktreeById(selectWorktreesByRepo(state), activeFile.worktreeId)
            if (!worktree) {
              return
            }
            const connectionId = getConnectionId(activeFile?.worktreeId ?? null) ?? undefined
            const target = getRuntimeTargetForFileOwner(
              state,
              activeFile.worktreeId,
              activeFile.runtimeEnvironmentId
            )
            if (!target) {
              return
            }
            const url = await getRuntimeGitRemoteFileUrl(
              {
                target,
                worktreeId: activeFile.worktreeId,
                worktreePath: worktree.path,
                connectionId
              },
              { relativePath, ...getRemoteUrlLineRange(line, selection) }
            )
            if (url) {
              window.api.ui.writeClipboardText(url)
            }
          }}
        >
          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
          {translate(
            'auto.components.editor.MonacoGutterContextMenu.7b57b1b468',
            'Copy Remote URL'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
