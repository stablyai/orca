import React, { useCallback } from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import {
  getLocalPathOpenOwnerForRoute,
  isLocalPathOpenBlocked,
  showLocalPathOpenBlockedToast
} from '@/lib/local-path-open-guard'
import { getLocalFileManagerLabel } from '@/lib/local-file-manager-label'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { getExternalEditorOpenCapability } from '@/lib/external-editor-open-capability'
import { NO_OPEN_IN_APPLICATIONS } from '@/lib/open-in-application-selection'
import { showOpenFailureToast } from './worktree-open-failure-toast'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'

export { getLocalFileManagerLabel } from '@/lib/local-file-manager-label'

type WorktreeOpenInMenuItemsProps = {
  worktreePath: string
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  ownerUnresolved?: boolean
  disabled?: boolean
  labelPrefix?: string
}

export type OpenInMenuEntry = {
  id: string
  label: string
  target: 'external-editor' | 'file-manager'
  command?: string
}

export function getWorktreeOpenInEntries(
  openInApplications: readonly OpenInApplication[],
  fileManagerLabel: string
): OpenInMenuEntry[] {
  return [
    ...openInApplications.map((application) => ({
      id: application.id,
      label: application.label,
      target: 'external-editor' as const,
      command: application.command
    })),
    { id: 'file-manager', label: fileManagerLabel, target: 'file-manager' }
  ]
}

export function getOpenInEntryAvailability(
  entry: OpenInMenuEntry,
  connectionId?: string | null,
  runtimeEnvironmentId?: string | null,
  ownerUnresolved?: boolean
): { disabled: boolean; metadata?: string } {
  if (entry.target === 'file-manager') {
    const disabled = isLocalPathOpenBlocked(
      getLocalPathOpenOwnerForRoute({ connectionId, runtimeEnvironmentId, ownerUnresolved })
    )
    return disabled
      ? {
          disabled: true,
          metadata: translate('auto.components.sidebar.WorktreeOpenInMenu.localOnly', 'Local only')
        }
      : { disabled: false }
  }
  const capability = getExternalEditorOpenCapability({
    connectionId,
    command: entry.command,
    runtimeEnvironmentId,
    ownerUnresolved
  })
  if (!capability.allowed) {
    return {
      disabled: true,
      metadata: translate('auto.components.sidebar.WorktreeOpenInMenu.localOnly', 'Local only')
    }
  }
  return capability.remote
    ? {
        disabled: false,
        metadata: translate('auto.components.sidebar.WorktreeOpenInMenu.remoteSsh', 'Remote SSH')
      }
    : { disabled: false }
}

function stopMenuPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

export function openOpenInAppsSettings(): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({
    pane: 'general',
    repoId: null,
    sectionId: 'general-open-in-apps'
  })
  store.openSettingsPage()
}

export async function openWorktreePath(args: {
  target: 'file-manager' | 'external-editor'
  worktreePath: string
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  ownerUnresolved?: boolean
  command?: string
}): Promise<void> {
  const owner = getLocalPathOpenOwnerForRoute({
    connectionId: args.connectionId,
    runtimeEnvironmentId: args.runtimeEnvironmentId,
    ownerUnresolved: args.ownerUnresolved
  })
  if (args.target === 'file-manager') {
    if (isLocalPathOpenBlocked(owner)) {
      showLocalPathOpenBlockedToast()
      return
    }
  } else {
    const capability = getExternalEditorOpenCapability({
      connectionId: args.connectionId,
      command: args.command,
      runtimeEnvironmentId: args.runtimeEnvironmentId,
      ownerUnresolved: args.ownerUnresolved
    })
    if (!capability.allowed) {
      if (capability.reason === 'remote-runtime') {
        showOpenFailureToast({ ok: false, reason: 'remote-runtime-unsupported' }, false)
      } else {
        showOpenFailureToast({ ok: false, reason: 'remote-editor-unsupported' }, true)
      }
      return
    }
  }
  // Why: both checks above refuse an unresolved owner, so this is only a narrowing guard.
  if (owner === 'unresolved') {
    return
  }

  const result =
    args.target === 'file-manager'
      ? await window.api.shell.openInFileManager(args.worktreePath, owner)
      : await window.api.shell.openInExternalEditor({
          path: args.worktreePath,
          command: args.command,
          connectionId: args.connectionId,
          ownerHostId: owner
        })
  if (!result.ok) {
    showOpenFailureToast(result, Boolean(args.connectionId?.trim()))
  }
}

function useOpenInWorktreePath({
  worktreePath,
  connectionId,
  runtimeEnvironmentId,
  ownerUnresolved
}: WorktreeOpenInMenuItemsProps): (
  target: 'file-manager' | 'external-editor',
  command?: string
) => Promise<void> {
  return useCallback(
    async (target, command) => {
      await openWorktreePath({
        target,
        worktreePath,
        connectionId,
        runtimeEnvironmentId,
        ownerUnresolved,
        command
      })
    },
    [connectionId, ownerUnresolved, runtimeEnvironmentId, worktreePath]
  )
}

export function WorktreeOpenInMenuItems({
  worktreePath,
  connectionId,
  runtimeEnvironmentId,
  ownerUnresolved,
  disabled,
  labelPrefix = ''
}: WorktreeOpenInMenuItemsProps): React.JSX.Element {
  const openInWorktreePath = useOpenInWorktreePath({
    worktreePath,
    connectionId,
    runtimeEnvironmentId,
    ownerUnresolved
  })
  const openInApplications = useAppStore(
    (s) => s.settings?.openInApplications ?? NO_OPEN_IN_APPLICATIONS
  )
  const fileManagerLabel = getLocalFileManagerLabel()
  const entries = getWorktreeOpenInEntries(openInApplications, fileManagerLabel)

  return (
    <>
      {entries.map((entry) => {
        const availability = getOpenInEntryAvailability(
          entry,
          connectionId,
          runtimeEnvironmentId,
          ownerUnresolved
        )
        return (
          <DropdownMenuItem
            key={entry.id}
            onClick={stopMenuPropagation}
            onSelect={() => {
              void openInWorktreePath(entry.target, entry.command)
            }}
            disabled={disabled || availability.disabled}
          >
            {entry.target === 'file-manager' ? (
              <FolderOpen className="size-3.5" />
            ) : entry.command ? (
              <OpenInApplicationIcon application={{ command: entry.command }} size={14} />
            ) : (
              <ExternalLink className="size-3.5" />
            )}
            <span className="min-w-0 truncate">
              {labelPrefix}
              {entry.label}
            </span>
            {availability.metadata ? (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {availability.metadata}
              </span>
            ) : null}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

export function WorktreeOpenInSubMenu({
  worktreePath,
  connectionId,
  runtimeEnvironmentId,
  ownerUnresolved,
  disabled
}: WorktreeOpenInMenuItemsProps): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <FolderOpen className="size-3.5" />
        {translate('auto.components.sidebar.WorktreeOpenInMenu.8009ab69a6', 'Open in')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-52"
        onClick={stopMenuPropagation}
        onPointerDown={stopMenuPropagation}
      >
        <WorktreeOpenInMenuItems
          worktreePath={worktreePath}
          connectionId={connectionId}
          runtimeEnvironmentId={runtimeEnvironmentId}
          ownerUnresolved={ownerUnresolved}
          disabled={disabled}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={stopMenuPropagation}
          onSelect={openOpenInAppsSettings}
          disabled={disabled}
        >
          {translate('auto.components.sidebar.WorktreeOpenInMenu.1417fd8380', 'Customize apps...')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
