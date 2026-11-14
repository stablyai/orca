import React, { useCallback, useRef, useState } from 'react'
import { FolderOpen, Globe, Plus, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '../../host-admission/ssh/AddRemoteHostDialog'
import type {
  AddProjectMenuAction,
  AddRepoDialogEntryRequest
} from '../dialog/add-repo-dialog-types'
import { useAddRepoHostSelection } from '../host-selection/use-add-repo-host-selection'
import { AddProjectHostSubmenu } from './AddProjectHostSubmenu'
import { launchAddProjectMenuAction } from './launch-add-project-menu-action'

const NOOP_SET_STEP = (): void => {}

const ACTION_ITEMS: readonly {
  action: AddProjectMenuAction
  Icon: LucideIcon
  label: (t: Translate) => string
  showShortcut?: boolean
}[] = [
  {
    action: 'browse',
    Icon: FolderOpen,
    label: (t) => t('auto.components.sidebar.AddProjectMenu.browseFolder', 'Browse folder…'),
    showShortcut: true
  },
  {
    action: 'clone',
    Icon: Globe,
    label: (t) => t('auto.components.sidebar.AddProjectMenu.cloneFromUrl', 'Clone from URL…')
  },
  {
    action: 'create',
    Icon: Plus,
    label: (t) =>
      t('auto.components.sidebar.AddProjectMenu.createNewProject', 'Create new project…')
  }
]

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

function AddProjectMenuOpenContent({
  defaultHostId,
  onOpenEntryRequest,
  onBeforeLaunchAction,
  onOpenRemoteHostDialog,
  onNavigateBack,
  onCloseAutoFocus,
  onCloseMenu,
  autoFocusFirstItem,
  side,
  align,
  sideOffset,
  preserveWorkspaceBoardOpen
}: {
  defaultHostId: ExecutionHostId | null
  onOpenEntryRequest: (request: AddRepoDialogEntryRequest) => void
  onBeforeLaunchAction?: () => void
  onOpenRemoteHostDialog: (mode: AddRemoteHostMode) => void
  onNavigateBack?: () => void
  onCloseAutoFocus?: (event: Event) => void
  onCloseMenu: () => void
  autoFocusFirstItem: boolean
  side: 'top' | 'right' | 'bottom' | 'left'
  align: 'start' | 'center' | 'end'
  sideOffset: number
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [hostSubOpen, setHostSubOpen] = useState(false)
  const browseItemRef = useRef<HTMLDivElement>(null)
  const hostSelection = useAddRepoHostSelection({
    isOpen: true,
    setStep: NOOP_SET_STEP,
    defaultHostId
  })

  const handleSelectAction = useCallback(
    (action: AddProjectMenuAction) => {
      const targetHostId = hostSelection.selectedHostId
      if (!targetHostId) {
        return
      }
      onCloseMenu()
      onBeforeLaunchAction?.()
      // Why: the menu is already closed, so a native picker failure needs a visible error.
      launchAddProjectMenuAction({ action, hostId: targetHostId, onOpenEntryRequest }).catch(
        (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
      )
    },
    [hostSelection.selectedHostId, onBeforeLaunchAction, onCloseMenu, onOpenEntryRequest]
  )

  const actionsDisabled = !hostSelection.selectedHostId
  const closeHostSubmenu = (): void => {
    if (hostSubOpen) {
      setHostSubOpen(false)
    }
  }

  return (
    <DropdownMenuContent
      side={side}
      align={align}
      sideOffset={sideOffset}
      className="w-60"
      data-add-project-menu=""
      data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      onCloseAutoFocus={onCloseAutoFocus}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        if (autoFocusFirstItem) {
          browseItemRef.current?.focus()
        }
      }}
      onKeyDown={(event) => {
        if (!onNavigateBack || hostSubOpen) {
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCloseMenu()
          onNavigateBack()
        }
      }}
    >
      <div className="flex min-h-[26px] items-center justify-between gap-2 py-0.5 pr-1 pl-2.5">
        <span className="shrink-0 text-2xs font-semibold text-muted-foreground select-none">
          {t('auto.components.sidebar.SidebarHeader.addProject', 'Add project')}
        </span>
        <AddProjectHostSubmenu
          hostSelection={hostSelection}
          subOpen={hostSubOpen}
          onSubOpenChange={setHostSubOpen}
          onOpenRemoteHostDialog={(mode) => {
            onBeforeLaunchAction?.()
            onOpenRemoteHostDialog(mode)
          }}
          onHostPicked={() => {
            requestAnimationFrame(() => browseItemRef.current?.focus())
          }}
          preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
        />
      </div>
      {ACTION_ITEMS.map(({ action, Icon, label, showShortcut }) => (
        <DropdownMenuItem
          key={action}
          ref={action === 'browse' ? browseItemRef : undefined}
          disabled={actionsDisabled}
          onPointerMove={closeHostSubmenu}
          onSelect={() => handleSelectAction(action)}
        >
          <Icon />
          <span className="truncate">{label(t)}</span>
          {showShortcut ? <DropdownMenuShortcut>↵</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  )
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
          <AddProjectMenuOpenContent
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
        ) : null}
      </DropdownMenu>
      {!onOpenRemoteHostDialog ? (
        <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={handleRemoteHostModeChange} />
      ) : null}
    </>
  )
}
