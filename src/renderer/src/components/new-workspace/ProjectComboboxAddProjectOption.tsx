import React from 'react'
import { ChevronRight, FolderPlus } from 'lucide-react'
import type { AddRemoteHostMode } from '@/components/sidebar/host-admission/ssh/AddRemoteHostDialog'
import type { AddRepoDialogEntryRequest } from '@/components/sidebar/project-admission/dialog/add-repo-dialog-types'
import { ADD_PROJECT_MENU_ATTRIBUTE } from '@/components/sidebar/project-admission/menu/AddProjectHostSubmenu'
import { AddProjectMenu } from '@/components/sidebar/project-admission/menu/AddProjectMenu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type ProjectComboboxAddProjectMenu = {
  defaultHostId?: ExecutionHostId | null
  onOpenEntryRequest: (request: AddRepoDialogEntryRequest) => void
  onOpenRemoteHostDialog?: (mode: AddRemoteHostMode) => void
}

export function focusCascadedAddProjectMenuFirstItem(): void {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(
        `[${ADD_PROJECT_MENU_ATTRIBUTE}] [role="menuitem"]:not([data-disabled])`
      )
      ?.focus()
  })
}

export function ProjectComboboxAddProjectOption({
  optionId,
  armed,
  cascadeOpen,
  cascadeAutoFocus,
  addProjectMenu,
  onAddProject,
  onArm,
  onCommitPlain,
  onCascadeOpenChange,
  onCascadeAutoFocusChange,
  onCloseCombobox,
  onFocusSearchInput
}: {
  optionId?: string
  armed: boolean
  cascadeOpen: boolean
  cascadeAutoFocus: boolean
  addProjectMenu?: ProjectComboboxAddProjectMenu
  onAddProject?: () => void
  onArm: () => void
  onCommitPlain: () => void
  onCascadeOpenChange: (open: boolean) => void
  onCascadeAutoFocusChange: (autoFocus: boolean) => void
  onCloseCombobox: () => void
  onFocusSearchInput: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const label = t('auto.components.new.workspace.ProjectCombobox.addProject', 'Add project')

  if (addProjectMenu) {
    return (
      <AddProjectMenu
        open={cascadeOpen}
        onOpenChange={onCascadeOpenChange}
        side="right"
        align="end"
        sideOffset={6}
        autoFocusFirstItem={cascadeAutoFocus}
        defaultHostId={addProjectMenu.defaultHostId}
        onOpenEntryRequest={addProjectMenu.onOpenEntryRequest}
        onBeforeLaunchAction={onCloseCombobox}
        onOpenRemoteHostDialog={addProjectMenu.onOpenRemoteHostDialog}
        onNavigateBack={() => {
          onCascadeOpenChange(false)
          onFocusSearchInput()
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div
          role="option"
          id={optionId}
          aria-selected={armed}
          aria-haspopup="menu"
          data-armed={armed || undefined}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => {
            onArm()
            onCascadeAutoFocusChange(false)
            onCascadeOpenChange(true)
          }}
          onMouseMove={() => {
            onArm()
            if (!cascadeOpen) {
              onCascadeAutoFocusChange(false)
              onCascadeOpenChange(true)
            }
          }}
          onClick={() => {
            onArm()
            onCascadeAutoFocusChange(true)
            if (cascadeOpen) {
              focusCascadedAddProjectMenuFirstItem()
            } else {
              onCascadeOpenChange(true)
            }
          }}
          className={cn(
            'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-3 text-sm',
            (armed || cascadeOpen) && 'bg-accent text-accent-foreground'
          )}
        >
          <span className="flex w-4 shrink-0 items-center justify-center">
            <FolderPlus className="size-3.5 text-muted-foreground" />
          </span>
          <span className="truncate">{label}</span>
          <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </div>
      </AddProjectMenu>
    )
  }

  if (!onAddProject) {
    return null
  }

  return (
    <div
      role="option"
      id={optionId}
      aria-selected={armed}
      data-armed={armed || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onArm}
      onClick={onCommitPlain}
      className={cn(
        'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-3 text-sm',
        armed && 'bg-accent text-accent-foreground'
      )}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        <FolderPlus className="size-3.5 text-muted-foreground" />
      </span>
      <span className="truncate">{label}</span>
    </div>
  )
}
