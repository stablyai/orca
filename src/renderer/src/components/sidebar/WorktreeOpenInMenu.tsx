import React, { useCallback } from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { getLocalFileManagerLabel } from '@/lib/local-file-manager-label'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { getExternalEditorOpenCapability } from '@/lib/external-editor-open-capability'
import type { ShellOpenExternalEditorResult } from '../../../../shared/shell-open-types'
import type { GlobalSettings, OpenInApplication } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export { getLocalFileManagerLabel } from '@/lib/local-file-manager-label'

type WorktreeOpenInMenuItemsProps = {
  worktreePath: string
  connectionId?: string | null
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
  openInApplications: OpenInApplication[],
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
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId?: string | null
): { disabled: boolean; metadata?: string } {
  if (entry.target === 'file-manager') {
    const disabled = isLocalPathOpenBlocked(settings, { connectionId })
    return disabled
      ? {
          disabled: true,
          metadata: translate('auto.components.sidebar.WorktreeOpenInMenu.localOnly', 'Local only')
        }
      : { disabled: false }
  }
  const capability = getExternalEditorOpenCapability(settings, {
    connectionId,
    command: entry.command
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

function showOpenFailureToast(
  result: Exclude<ShellOpenExternalEditorResult, { ok: true }>,
  remote: boolean
): void {
  if (result.reason === 'remote-runtime-unsupported') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.remoteRuntimeUnsupported',
        'Opening this path in a local app is not available.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.remoteRuntimeUnsupportedDetail',
          'Switch to a local or SSH workspace, then try again.'
        )
      }
    )
    return
  }
  if (result.reason === 'ssh-target-not-found') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.sshTargetNotFound',
        'SSH host is no longer available.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.sshTargetNotFoundDetail',
          'Refresh workspaces or reconnect the host, then try again.'
        )
      }
    )
    return
  }
  if (result.reason === 'ssh-target-invalid') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.sshTargetInvalid',
        'SSH host configuration is incomplete.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.sshTargetInvalidDetail',
          'Edit or reconnect the SSH host, then try again.'
        )
      }
    )
    return
  }
  if (result.reason === 'ssh-alias-required') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.sshAliasRequired',
        'VS Code needs an SSH config alias for this host.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.sshAliasRequiredDetail',
          'Add a Host alias for {{host}}:{{port}} to your local SSH config, reconnect the workspace, then try again.',
          { host: result.host, port: result.port }
        )
      }
    )
    return
  }
  if (result.reason === 'remote-editor-unsupported') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.remoteEditorUnsupported',
        'This app cannot open SSH workspaces.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.remoteEditorUnsupportedDetail',
          'Choose VS Code or use the app locally.'
        )
      }
    )
    return
  }
  if (result.reason === 'not-absolute') {
    toast.error(
      remote
        ? translate(
            'auto.components.sidebar.WorktreeOpenInMenu.remotePathInvalid',
            'Path is not valid for the SSH host.'
          )
        : translate(
            'auto.components.sidebar.WorktreeOpenInMenu.f387af445b',
            'Workspace path is not a valid local path.'
          ),
      remote
        ? {
            description: translate(
              'auto.components.sidebar.WorktreeOpenInMenu.remotePathInvalidDetail',
              'Refresh the workspace before trying again.'
            )
          }
        : undefined
    )
    return
  }
  if (result.reason === 'not-found') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.3921d3d9a5',
        'Workspace folder was not found.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.0bed8727db',
          'It may have been moved or deleted. Refresh workspaces or remove it from Orca.'
        )
      }
    )
    return
  }
  if (remote) {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.remoteLaunchFailed',
        'Could not open the path in VS Code.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.remoteLaunchFailedDetail',
          'Check the VS Code command configured on this machine.'
        )
      }
    )
    return
  }
  toast.error(
    translate(
      'auto.components.sidebar.WorktreeOpenInMenu.9a5381eb09',
      'Could not open workspace folder.'
    ),
    {
      description: translate(
        'auto.components.sidebar.WorktreeOpenInMenu.bd0e8159f8',
        'Check the editor command or file manager configuration on this machine.'
      )
    }
  )
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
  command?: string
}): Promise<void> {
  const settings = useAppStore.getState().settings
  if (args.target === 'file-manager') {
    if (isLocalPathOpenBlocked(settings, { connectionId: args.connectionId ?? null })) {
      showLocalPathOpenBlockedToast()
      return
    }
  } else {
    const capability = getExternalEditorOpenCapability(settings, {
      connectionId: args.connectionId,
      command: args.command
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

  const result =
    args.target === 'file-manager'
      ? await window.api.shell.openInFileManager(args.worktreePath)
      : await window.api.shell.openInExternalEditor({
          path: args.worktreePath,
          command: args.command,
          connectionId: args.connectionId
        })
  if (!result.ok) {
    showOpenFailureToast(result, Boolean(args.connectionId?.trim()))
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
  disabled,
  labelPrefix = ''
}: WorktreeOpenInMenuItemsProps): React.JSX.Element {
  const openInWorktreePath = useOpenInWorktreePath({ worktreePath, connectionId })
  const openInApplications = useAppStore((s) => s.settings?.openInApplications ?? [])
  const settings = useAppStore((s) => s.settings)
  const fileManagerLabel = getLocalFileManagerLabel()
  const entries = getWorktreeOpenInEntries(openInApplications, fileManagerLabel)

  return (
    <>
      {entries.map((entry) => {
        const availability = getOpenInEntryAvailability(entry, settings, connectionId)
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
