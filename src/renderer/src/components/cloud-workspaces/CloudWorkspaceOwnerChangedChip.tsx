// OWNER-TRANSFER: "Owner changed" in the top bar when the cloud workspace in front has had more
// than one owner. It says why personal secrets and sign-ins are not used there; nothing to click.
import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useCloudWorktreeOwnerChanged } from './cloud-workspace-identity'
import { ownerChangedExplanation, ownerChangedLabel } from './owner-change-copy'

export function OwnerChangedChip(): React.JSX.Element {
  const t = useTranslate()
  const explanation = ownerChangedExplanation(t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // Focusable so the explanation is reachable from the keyboard.
          tabIndex={0}
          role="note"
          aria-description={explanation}
          data-cloud-owner-changed=""
          className="mr-2 flex h-6 shrink-0 items-center rounded-md border border-border px-1.5 text-2xs whitespace-nowrap text-muted-foreground outline-none [-webkit-app-region:no-drag] max-[960px]:hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
        >
          {ownerChangedLabel(t)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-xs">
        {explanation}
      </TooltipContent>
    </Tooltip>
  )
}

/** Renders nothing for local workspaces and for cloud workspaces that never changed owner. */
export function CloudWorkspaceOwnerChangedChip({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const hostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const changed = useCloudWorktreeOwnerChanged({ id: worktreeId, hostId })
  return changed ? <OwnerChangedChip /> : null
}
