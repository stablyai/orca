// W-123 in the top bar when the workspace in front is a cloud workspace; click copies its link
// (the same as ⌘⌥⇧L). Renders nothing for local workspaces or before the number is known.
import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { formatWorkspaceNumber } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { sandboxIdForWorktree, useCloudWorkspaceIdentities } from './cloud-workspace-identity'
import { frontCloudChat } from './cloud-workspace-links'
import { copyCloudWorkspaceLink } from './open-cloud-workspace'

export function CloudWorkspaceNumberChip({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const keybindings = useAppStore((s) => s.keybindings)
  const identities = useCloudWorkspaceIdentities()
  const sandboxId = sandboxIdForWorktree({ id: worktreeId, hostId }, identities)
  const number = sandboxId ? (identities.bySandbox.get(sandboxId)?.number ?? null) : null
  if (!sandboxId || !number) {
    return null
  }
  const label = formatWorkspaceNumber(number)
  const shortcut = formatOptionalPrimaryShortcutLabel('cloudWorkspace.copyLink', keybindings)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            const front = frontCloudChat()
            void copyCloudWorkspaceLink(
              sandboxId,
              front?.sandboxId === sandboxId ? front.chatId : null
            )
          }}
          aria-label={t('auto.components.cloudWorkspaces.copyLinkFor', 'Copy link to {{number}}', {
            number: label
          })}
          className="mr-2 flex h-6 items-center rounded-md px-1.5 font-mono text-2xs tabular-nums text-muted-foreground outline-none [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {t('auto.components.cloudWorkspaces.copyLink', 'Copy link')}
        {shortcut ? <span className="ml-1.5 text-muted-foreground">{shortcut}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}
