import React, { useId } from 'react'
import {
  Copy,
  Download,
  FileX,
  KeyRound,
  ShieldOff,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { BUILT_IN_EDITOR_COMMANDS } from '../../../../../../shared/open-in-applications'
import type { CloudSshStatus } from '../../../../../../shared/cloud-ssh'
import {
  copyCloudSshCommand,
  openCloudWorkspaceInEditor,
  removeCloudSshConfigInclude,
  revokeCloudSshAccess
} from './cloud-ssh-actions'

function stopMenuPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

function MenuHint({
  id,
  icon: Icon,
  children
}: {
  id?: string
  icon: LucideIcon
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p
      id={id}
      className="flex items-start gap-2 px-2.5 py-1.5 text-2xs leading-snug text-muted-foreground"
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** VS Code / Cursor over SSH in an Orca Cloud workspace's "Open in" submenu. `status` is null
 *  while it loads, so the submenu keeps its final shape instead of swapping rows. */
export function CloudSshEditorMenuItems({
  workspaceId,
  status,
  disabled
}: {
  workspaceId: string
  status: CloudSshStatus | null
  disabled?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!status) {
    return null
  }
  if (status.editors.length === 0) {
    return (
      <MenuHint icon={Download}>
        {t(
          'auto.components.sidebar.CloudSsh.noEditors',
          'Install VS Code or Cursor to open over SSH.'
        )}
      </MenuHint>
    )
  }
  return (
    <>
      {status.editors.map((editor) => (
        <DropdownMenuItem
          key={editor.id}
          onClick={stopMenuPropagation}
          onSelect={() =>
            void openCloudWorkspaceInEditor({
              workspaceId,
              editor,
              status,
              allowSshConfigInclude: false
            })
          }
          disabled={disabled}
        >
          <OpenInApplicationIcon
            application={{ command: BUILT_IN_EDITOR_COMMANDS[editor.kind] }}
            size={14}
          />
          <span className="min-w-0 truncate">{editor.label}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {t('auto.components.sidebar.WorktreeOpenInMenu.remoteSsh', 'Remote SSH')}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** "SSH" submenu of an Orca Cloud workspace: copy the command, revoke this computer's key.
 *  Disabled while the status loads so the parent menu never gains a row under the pointer. */
export function CloudSshMenuItems({
  workspaceId,
  status,
  disabled
}: {
  workspaceId: string
  status: CloudSshStatus | null
  disabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const hintId = useId()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled || !status}>
        <SquareTerminal className="size-3.5" />
        {t('auto.components.sidebar.CloudSsh.menu', 'SSH')}
      </DropdownMenuSubTrigger>
      {status ? (
        <DropdownMenuSubContent
          className="w-60"
          onClick={stopMenuPropagation}
          onPointerDown={stopMenuPropagation}
        >
          <DropdownMenuItem
            onSelect={() => void copyCloudSshCommand(workspaceId, status)}
            disabled={disabled}
            aria-describedby={status.hasAccess ? undefined : hintId}
          >
            <Copy className="size-3.5" />
            {t('auto.components.sidebar.CloudSsh.copyCommand', 'Copy SSH Command')}
          </DropdownMenuItem>
          {status.hasAccess ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void revokeCloudSshAccess(workspaceId)}
                disabled={disabled}
              >
                <ShieldOff className="size-3.5" />
                {t('auto.components.sidebar.CloudSsh.revoke', 'Revoke SSH Access')}
              </DropdownMenuItem>
              {status.includeInstalled ? (
                <DropdownMenuItem
                  onSelect={() => void removeCloudSshConfigInclude()}
                  disabled={disabled}
                >
                  <FileX className="size-3.5" />
                  {t('auto.components.sidebar.CloudSsh.removeInclude', 'Remove from ~/.ssh/config')}
                </DropdownMenuItem>
              ) : null}
            </>
          ) : (
            <MenuHint id={hintId} icon={KeyRound}>
              {t(
                'auto.components.sidebar.CloudSsh.firstUseHint',
                'Your first connection adds this computer’s key.'
              )}
            </MenuHint>
          )}
        </DropdownMenuSubContent>
      ) : null}
    </DropdownMenuSub>
  )
}
