import React, { useCallback } from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import type { ShellOpenLocalPathFailureReason } from '../../../../shared/shell-open-types'
import type { OpenInApplication } from '../../../../shared/types'

type WorktreeOpenInMenuItemsProps = {
  worktreePath: string
  connectionId?: string | null
  disabled?: boolean
}

type OpenInMenuEntry = {
  id: string
  label: string
  target: 'external-editor' | 'file-manager'
  command?: string
}

export function getLocalFileManagerLabel(userAgent?: string): string {
  const resolvedUserAgent =
    userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (resolvedUserAgent.includes('Mac')) {
    return 'Finder'
  }
  if (resolvedUserAgent.includes('Windows')) {
    return 'File Explorer'
  }
  return 'File Manager'
}

export function getWorktreeOpenInEntries(
  openInApplications: OpenInApplication[],
  fileManagerLabel: string
): OpenInMenuEntry[] {
  return [
    { id: 'vscode', label: 'VS Code', target: 'external-editor' },
    ...openInApplications.map((application) => ({
      id: application.id,
      label: application.label,
      target: 'external-editor' as const,
      command: application.command
    })),
    { id: 'file-manager', label: fileManagerLabel, target: 'file-manager' }
  ]
}

function showOpenFailureToast(reason: ShellOpenLocalPathFailureReason): void {
  if (reason === 'not-absolute') {
    toast.error('Workspace path is not a valid local path.')
    return
  }
  if (reason === 'not-found') {
    toast.error('Workspace folder was not found.', {
      description: 'It may have been moved or deleted. Refresh workspaces or remove it from Orca.'
    })
    return
  }
  toast.error('Could not open workspace folder.', {
    description: 'Check the editor command or file manager configuration on this machine.'
  })
}

function stopMenuPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

export async function openWorktreePath(args: {
  target: 'file-manager' | 'external-editor'
  worktreePath: string
  connectionId?: string | null
  command?: string
}): Promise<void> {
  if (
    isLocalPathOpenBlocked(useAppStore.getState().settings, {
      connectionId: args.connectionId ?? null
    })
  ) {
    showLocalPathOpenBlockedToast()
    return
  }

  const result =
    args.target === 'file-manager'
      ? await window.api.shell.openInFileManager(args.worktreePath)
      : await window.api.shell.openInExternalEditor(args.worktreePath, args.command)
  if (!result.ok) {
    showOpenFailureToast(result.reason)
  }
}

function useOpenInWorktreePath({
  worktreePath,
  connectionId
}: WorktreeOpenInMenuItemsProps): (
  target: 'file-manager' | 'external-editor',
  command?: string
) => Promise<void> {
  return useCallback(
    async (target, command) => {
      await openWorktreePath({ target, worktreePath, connectionId, command })
    },
    [connectionId, worktreePath]
  )
}

export function WorktreeOpenInMenuItems({
  worktreePath,
  connectionId,
  disabled
}: WorktreeOpenInMenuItemsProps): React.JSX.Element {
  const openInWorktreePath = useOpenInWorktreePath({ worktreePath, connectionId })
  const openInApplications = useAppStore((s) => s.settings?.openInApplications ?? [])
  const fileManagerLabel = getLocalFileManagerLabel()
  const entries = getWorktreeOpenInEntries(openInApplications, fileManagerLabel)

  return (
    <>
      {entries.map((entry) => (
        <DropdownMenuItem
          key={entry.id}
          onClick={stopMenuPropagation}
          onSelect={() => {
            void openInWorktreePath(entry.target, entry.command)
          }}
          disabled={disabled}
        >
          {entry.target === 'file-manager' ? (
            <FolderOpen className="size-3.5" />
          ) : (
            <ExternalLink className="size-3.5" />
          )}
          {entry.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}

export function WorktreeOpenInSubMenu({
  worktreePath,
  connectionId,
  disabled
}: WorktreeOpenInMenuItemsProps): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <FolderOpen className="size-3.5" />
        Open in
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-52"
        onClick={stopMenuPropagation}
        onPointerDown={stopMenuPropagation}
      >
        <WorktreeOpenInMenuItems
          worktreePath={worktreePath}
          connectionId={connectionId}
          disabled={disabled}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
