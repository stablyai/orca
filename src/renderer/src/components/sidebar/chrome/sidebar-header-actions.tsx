import React, { useCallback, useRef, useState } from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatOptionalPrimaryShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { openWorkspaceCreationComposerWithTourHandoff } from '../../contextual-tours/workspace-creation-tour-handoff'
import type { AddRepoDialogEntryRequest } from '../project-admission/dialog/add-repo-dialog-types'
import { AddProjectMenu } from '../project-admission/menu/AddProjectMenu'
import SidebarWorkspaceOptionsMenu from '../worktree-list/controls/SidebarWorkspaceOptionsMenu'
import { ProjectGroupNameDialog } from '../worktree-list/rows/ProjectGroupNameDialog'

function AddProjectButton({
  preserveWorkspaceBoardOpen,
  onMenuOpenChange
}: {
  preserveWorkspaceBoardOpen: boolean
  onMenuOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  // Host the empty group is created on; null while the name dialog is closed.
  const [newGroupHostId, setNewGroupHostId] = useState<ExecutionHostId | null>(null)
  const label = t('auto.components.sidebar.SidebarHeader.addProject', 'Add project')
  const handleOpenEntryRequest = useCallback(
    (entryRequest: AddRepoDialogEntryRequest) => {
      openModal('add-repo', { entryRequest })
    },
    [openModal]
  )
  const handleSubmitNewGroup = useCallback(
    async (name: string) => {
      if (newGroupHostId && !(await createProjectGroup(name, newGroupHostId))) {
        toast.error(
          t('auto.components.sidebar.SidebarHeader.newProjectGroupFailed', 'Could not create group')
        )
      }
    },
    [createProjectGroup, newGroupHostId, t]
  )

  return (
    <>
      <AddProjectMenu
        side="bottom"
        align="start"
        tooltipLabel={label}
        tooltipSide="bottom"
        preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
        onOpenChange={onMenuOpenChange}
        onOpenEntryRequest={handleOpenEntryRequest}
        onCreateProjectGroup={setNewGroupHostId}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="text-muted-foreground"
          aria-label={label}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          <FolderPlus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </AddProjectMenu>
      <ProjectGroupNameDialog
        open={newGroupHostId !== null}
        title={t('auto.components.sidebar.WorktreeList.13757c053c', 'New Project Group')}
        description={t(
          'auto.components.sidebar.SidebarHeader.newProjectGroupDesc',
          'Create an empty group. Drag projects into it or use Move to group.'
        )}
        initialName=""
        confirmLabel={t('auto.components.sidebar.ProjectGroupNameDialog.create', 'Create')}
        onOpenChange={(open) => {
          if (!open) {
            setNewGroupHostId(null)
          }
        }}
        onSubmit={handleSubmitNewGroup}
      />
    </>
  )
}

function NewWorkspaceButton({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const keybindings = useAppStore((s) => s.keybindings)
  // Show the primary create shortcut so aliases do not crowd the tooltip.
  const shortcutLabel = formatOptionalPrimaryShortcutLabel('workspace.create', keybindings)
  const label = t('auto.components.sidebar.SidebarHeader.92154beb7e', 'New workspace')

  const handleCreateWorkspace = useCallback(() => {
    openWorkspaceCreationComposerWithTourHandoff()
  }, [])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="text-muted-foreground"
          aria-label={label}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          data-contextual-tour-target="workspace-create-control"
          onClick={handleCreateWorkspace}
        >
          <Plus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
        {shortcutLabel ? <span className="ml-1.5 text-background/60">{shortcutLabel}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export function SidebarHeaderActions({
  onWorkspaceBoardMenuOpenChange,
  agentsViewActive = false,
  activityOptionsTarget
}: {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  agentsViewActive?: boolean
  activityOptionsTarget?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const openMenusRef = useRef({ options: false, addProject: false })
  const updateMenuOpen = useCallback(
    (menu: 'options' | 'addProject', open: boolean) => {
      openMenusRef.current[menu] = open
      onWorkspaceBoardMenuOpenChange(
        openMenusRef.current.options || openMenusRef.current.addProject
      )
    },
    [onWorkspaceBoardMenuOpenChange]
  )

  return (
    <div className="flex shrink-0 items-center gap-1" data-sidebar-header-actions="">
      <div ref={activityOptionsTarget} className="flex size-6 shrink-0 items-center">
        {agentsViewActive ? null : (
          <SidebarWorkspaceOptionsMenu
            preserveWorkspaceBoardOpen
            onMenuOpenChange={(open) => updateMenuOpen('options', open)}
          />
        )}
      </div>
      <AddProjectButton
        preserveWorkspaceBoardOpen
        onMenuOpenChange={(open) => updateMenuOpen('addProject', open)}
      />
      <NewWorkspaceButton preserveWorkspaceBoardOpen />
    </div>
  )
}
