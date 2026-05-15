import React, { useCallback } from 'react'
import { ChevronDown, ExternalLink, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import type { ShellOpenLocalPathFailureReason } from '../../../../shared/shell-open-types'

type WorktreeOpenInMenuItemsProps = {
  worktreePath: string
  connectionId?: string | null
  disabled?: boolean
}

type WorktreeOpenInControlProps = WorktreeOpenInMenuItemsProps & {
  className?: string
}

export function getLocalFileManagerLabel(userAgent?: string): string {
  const resolvedUserAgent =
    userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (resolvedUserAgent.includes('Mac')) {
    return 'Open in Finder'
  }
  if (resolvedUserAgent.includes('Windows')) {
    return 'Open in File Explorer'
  }
  return 'Open in File Manager'
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
      : await window.api.shell.openInExternalEditor(args.worktreePath)
  if (!result.ok) {
    showOpenFailureToast(result.reason)
  }
}

function useOpenInWorktreePath({
  worktreePath,
  connectionId
}: WorktreeOpenInMenuItemsProps): (target: 'file-manager' | 'external-editor') => Promise<void> {
  return useCallback(
    async (target) => {
      await openWorktreePath({ target, worktreePath, connectionId })
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
  const fileManagerLabel = getLocalFileManagerLabel()

  return (
    <>
      <DropdownMenuItem
        onClick={stopMenuPropagation}
        onSelect={() => {
          void openInWorktreePath('external-editor')
        }}
        disabled={disabled}
      >
        <ExternalLink className="size-3.5" />
        Open in External Editor
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={stopMenuPropagation}
        onSelect={() => {
          void openInWorktreePath('file-manager')
        }}
        disabled={disabled}
      >
        <FolderOpen className="size-3.5" />
        {fileManagerLabel}
      </DropdownMenuItem>
    </>
  )
}

export function WorktreeOpenInControl({
  worktreePath,
  connectionId,
  disabled,
  className
}: WorktreeOpenInControlProps): React.JSX.Element | null {
  if (connectionId) {
    return null
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={cn(
                'h-5 shrink-0 gap-0.5 px-1 text-muted-foreground hover:text-foreground',
                className
              )}
              aria-label="Open in"
              disabled={disabled}
              onClick={stopMenuPropagation}
              onDoubleClick={stopMenuPropagation}
              onMouseDown={stopMenuPropagation}
              onPointerDown={stopMenuPropagation}
            >
              <FolderOpen className="size-3" />
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          Open in
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-52"
        onClick={stopMenuPropagation}
        onPointerDown={stopMenuPropagation}
      >
        <WorktreeOpenInMenuItems
          worktreePath={worktreePath}
          connectionId={connectionId}
          disabled={disabled}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
