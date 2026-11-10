// The chevron half of the sidebar's New workspace button (spec E2): New cloud workspace and
// New workspace on this computer. Hidden when this build has no Orca Cloud.
import React from 'react'
import { ChevronDown, Cloud, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorkspacesAvailable } from '@/components/cloud-workspaces/use-cloud-workspaces'
import { openNewCloudWorkspace } from '@/hooks/ipc-events/new-workspace-command'

export function NewWorkspaceMoreMenu({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const available = useCloudWorkspacesAvailable()
  const keybindings = useAppStore((s) => s.keybindings)
  if (available !== true) {
    return null
  }
  const cloudShortcut = formatOptionalPrimaryShortcutLabel('workspace.createCloud', keybindings)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="-ml-1 w-4 text-muted-foreground"
          aria-label={t('components.sidebar.newWorkspaceMore', 'More ways to create')}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          <ChevronDown className="size-3" strokeWidth={2.25} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-56">
        <DropdownMenuItem onSelect={() => openNewCloudWorkspace(useAppStore.getState(), 'sidebar')}>
          <Cloud className="size-3.5" />
          {t('keybindings.title.workspaceCreateCloud', 'New cloud workspace')}
          {cloudShortcut ? <DropdownMenuShortcut>{cloudShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            useAppStore.getState().openModal('new-workspace-composer', {
              telemetrySource: 'sidebar',
              initialRunOnLocal: true
            })
          }
        >
          <Monitor className="size-3.5" />
          {t('components.sidebar.newWorkspaceLocal', 'New workspace on this computer')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
