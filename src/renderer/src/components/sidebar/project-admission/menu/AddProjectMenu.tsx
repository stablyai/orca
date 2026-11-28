import React, { useCallback, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '../../host-admission/ssh/AddRemoteHostDialog'
import type { AddRepoDialogEntryRequest } from '../dialog/add-repo-dialog-types'

const LazyAddProjectMenuOpenContent = lazyWithRetry(
  () =>
    import('./AddProjectMenuOpenContent').then((module) => ({
      default: module.AddProjectMenuOpenContent
    })),
  { reloadKey: 'add-project-menu-open-content' }
)

type AddProjectMenuProps = {
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultHostId?: ExecutionHostId | null
  onOpenEntryRequest: (request: AddRepoDialogEntryRequest) => void
  onBeforeLaunchAction?: () => void
  onOpenRemoteHostDialog?: (mode: AddRemoteHostMode) => void
  onRemoteHostDialogOpenChange?: (open: boolean) => void
  onNavigateBack?: () => void
  onCloseAutoFocus?: (event: Event) => void
  autoFocusFirstItem?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  tooltipLabel?: string
  tooltipSide?: 'top' | 'bottom'
  preserveWorkspaceBoardOpen?: boolean
}

export function AddProjectMenu({
  children,
  open: controlledOpen,
  onOpenChange,
  defaultHostId = null,
  onOpenEntryRequest,
  onBeforeLaunchAction,
  onOpenRemoteHostDialog,
  onRemoteHostDialogOpenChange,
  onNavigateBack,
  onCloseAutoFocus,
  autoFocusFirstItem = true,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  tooltipLabel,
  tooltipSide = 'bottom',
  preserveWorkspaceBoardOpen = false
}: AddProjectMenuProps): React.JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const [addRemoteHostMode, setAddRemoteHostMode] = useState<AddRemoteHostMode | null>(null)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(next)
      }
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange]
  )

  const handleRemoteHostModeChange = useCallback(
    (nextMode: AddRemoteHostMode | null) => {
      setAddRemoteHostMode(nextMode)
      onRemoteHostDialogOpenChange?.(nextMode !== null)
    },
    [onRemoteHostDialogOpenChange]
  )

  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
        {tooltipLabel ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide} sideOffset={6}>
              {tooltipLabel}
            </TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        )}
        {open ? (
          <React.Suspense fallback={null}>
            <LazyAddProjectMenuOpenContent
              defaultHostId={defaultHostId}
              onOpenEntryRequest={onOpenEntryRequest}
              onBeforeLaunchAction={onBeforeLaunchAction}
              onOpenRemoteHostDialog={onOpenRemoteHostDialog ?? handleRemoteHostModeChange}
              onNavigateBack={onNavigateBack}
              onCloseAutoFocus={onCloseAutoFocus}
              onCloseMenu={() => handleOpenChange(false)}
              autoFocusFirstItem={autoFocusFirstItem}
              side={side}
              align={align}
              sideOffset={sideOffset}
              preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
            />
          </React.Suspense>
        ) : null}
      </DropdownMenu>
      {!onOpenRemoteHostDialog ? (
        <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={handleRemoteHostModeChange} />
      ) : null}
    </>
  )
}
