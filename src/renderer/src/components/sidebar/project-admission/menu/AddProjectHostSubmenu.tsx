import React, { useMemo, useState } from 'react'
import { ChevronRight, Circle, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  useDropdownMenuClose
} from '@/components/ui/dropdown-menu'
import { HostListOverflowNote } from '@/components/host-picker/HostListOverflowNote'
import { HostListSearchField } from '@/components/host-picker/HostListSearchField'
import { useBoundedHostRows } from '@/components/host-picker/use-bounded-host-rows'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AddRemoteHostMode } from '../../host-admission/ssh/AddRemoteHostDialog'
import {
  openWslHostsExperimentalSetting,
  useWslHostsAcceptNewWork,
  useWslHostsPaused
} from '../../use-wsl-hosts-enabled'
import { sidebarHostDisplayLabel } from '../../worktree-list/controls/sidebar-host-options'
import { getWslHostsPausedShortLabel } from '../../wsl-host-row-status'
import {
  canConnectAddRepoHost,
  canSelectAddRepoHost
} from '../host-selection/add-repo-host-availability'
import { getAddRepoHostStatusDetail } from '../host-selection/AddRepoHostSelector'
import type { useAddRepoHostSelection } from '../host-selection/use-add-repo-host-selection'

export const ADD_PROJECT_MENU_ATTRIBUTE = 'data-add-project-menu'

export function isWithinAddProjectMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${ADD_PROJECT_MENU_ATTRIBUTE}]`) !== null
}

type AddProjectHostSubmenuProps = {
  hostSelection: ReturnType<typeof useAddRepoHostSelection>
  subOpen: boolean
  onSubOpenChange: (open: boolean) => void
  onOpenRemoteHostDialog: (mode: AddRemoteHostMode) => void
  onHostPicked?: () => void
  preserveWorkspaceBoardOpen?: boolean
}

export function AddProjectHostSubmenu({
  hostSelection,
  subOpen,
  onSubOpenChange,
  onOpenRemoteHostDialog,
  onHostPicked,
  preserveWorkspaceBoardOpen = false
}: AddProjectHostSubmenuProps): React.JSX.Element | null {
  const t = useTranslate()
  const closeParentMenu = useDropdownMenuClose()
  const [addRemoteSubOpen, setAddRemoteSubOpen] = useState(false)
  const wslHostsAcceptNewWork = useWslHostsAcceptNewWork()
  const wslHostsPaused = useWslHostsPaused()
  const wslHostsPausedNote = wslHostsPaused ? getWslHostsPausedShortLabel(t) : undefined

  const searchableItems = useMemo(
    () =>
      hostSelection.hostOptions.map((item) => ({
        ...item,
        searchText: sidebarHostDisplayLabel(item, t)
      })),
    [hostSelection.hostOptions, t]
  )
  const rows = useBoundedHostRows(
    searchableItems,
    new Set(hostSelection.displayedHostId ? [hostSelection.displayedHostId] : [])
  )

  const selectedHost =
    hostSelection.hostOptions.find((item) => item.id === hostSelection.displayedHostId) ??
    hostSelection.hostOptions[0]
  if (!selectedHost) {
    return null
  }

  const triggerLabel = sidebarHostDisplayLabel(selectedHost, t)

  const handleOpenAddHost = (mode: AddRemoteHostMode): void => {
    setAddRemoteSubOpen(false)
    onSubOpenChange(false)
    closeParentMenu()
    onOpenRemoteHostDialog(mode)
  }

  const handleSelectHost = (hostId: ExecutionHostId, disabled: boolean): void => {
    if (disabled) {
      return
    }
    void hostSelection.handleSelectAddProjectHost(hostId).then((didSelect) => {
      if (didSelect) {
        onSubOpenChange(false)
        onHostPicked?.()
      }
    })
  }

  return (
    <DropdownMenuSub
      open={subOpen}
      onOpenChange={(next) => {
        onSubOpenChange(next)
        if (!next) {
          setAddRemoteSubOpen(false)
        }
      }}
    >
      <DropdownMenuSubTrigger
        variant="header-chip"
        hideChevron
        aria-label={t(
          'auto.components.sidebar.AddProjectMenu.changeProjectHost',
          'Project host: {{host}}',
          {
            host: triggerLabel
          }
        )}
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronRight className="size-3 shrink-0 text-current opacity-75" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={8}
        alignOffset={-4}
        scrollable
        className="w-64"
        data-add-project-menu=""
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuLabel>
          {t('auto.components.sidebar.AddProjectMenu.projectHost', 'Project host')}
        </DropdownMenuLabel>
        {rows.searchable ? (
          <HostListSearchField value={rows.query} onChange={rows.setQuery} inMenu />
        ) : null}
        {rows.shown.map((row) => {
          const selected = row.id === hostSelection.displayedHostId
          const disabled = !canSelectAddRepoHost(row)
          const canConnectHost = canConnectAddRepoHost(row)
          const canTurnOn = row.wslUnavailable === 'turned-off'
          const canInteract = !disabled || canConnectHost || canTurnOn
          const isConnecting = row.health === 'connecting'
          return (
            <DropdownMenuItem
              key={row.id}
              disabled={!canInteract}
              onSelect={(event) => {
                // Keep the parent Add project menu open when switching hosts so the user can pick an action next.
                event.preventDefault()
                handleSelectHost(row.id, disabled)
              }}
            >
              <span className="flex w-full min-w-0 items-start gap-2 py-0.5">
                <span className="mt-1 flex size-3.5 shrink-0 items-center justify-center">
                  {selected ? <Circle className="size-2 fill-current text-foreground" /> : null}
                </span>
                <span className={cn('min-w-0 flex-1', disabled && canInteract && 'opacity-60')}>
                  <span className="block truncate text-[13px] leading-4 font-normal text-foreground">
                    {sidebarHostDisplayLabel(row, t)}
                  </span>
                  <span
                    className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground"
                    title={row.failureReason}
                  >
                    {getAddRepoHostStatusDetail(row, t)}
                  </span>
                </span>
                {canConnectHost ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="ml-1 h-auto shrink-0 justify-end self-center"
                    disabled={isConnecting}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void hostSelection.handleConnectAddProjectHost(row.id).then((connected) => {
                        if (connected) {
                          onSubOpenChange(false)
                          onHostPicked?.()
                        }
                      })
                    }}
                  >
                    {isConnecting ? <Loader2 className="size-3 animate-spin" /> : null}
                    {isConnecting
                      ? t('auto.components.sidebar.AddRepoHostSelector.connecting', 'Connecting')
                      : t('auto.components.sidebar.AddRepoHostSelector.connect', 'Connect')}
                  </Button>
                ) : canTurnOn ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="ml-1 h-auto shrink-0 self-center"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onSubOpenChange(false)
                      closeParentMenu()
                      openWslHostsExperimentalSetting()
                    }}
                  >
                    {t('auto.components.sidebar.AddRepoHostSelector.turnOnWslHosts', 'Turn on')}
                  </Button>
                ) : null}
              </span>
            </DropdownMenuItem>
          )
        })}
        <HostListOverflowNote hiddenCount={rows.hiddenCount} />
        {rows.query === '' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub open={addRemoteSubOpen} onOpenChange={setAddRemoteSubOpen}>
              <DropdownMenuSubTrigger>
                <Plus className="size-[15px] text-muted-foreground" />
                <span className="truncate">
                  {t('auto.components.sidebar.AddProjectMenu.addRemoteHost', 'Add remote host…')}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={6}
                className="w-64"
                data-add-project-menu=""
                data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
              >
                <DropdownMenuItem onSelect={() => handleOpenAddHost('ssh')}>
                  <span className="flex flex-col items-start gap-0.5 py-0.5">
                    <span className="text-xs font-medium text-foreground">
                      {t('auto.components.sidebar.AddRepoHostSelector.addSshHost', 'Add SSH host')}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t(
                        'auto.components.sidebar.AddRepoHostSelector.addSshHostDetail',
                        'Use an existing machine over SSH.'
                      )}
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleOpenAddHost('server')}>
                  <span className="flex flex-col items-start gap-0.5 py-0.5">
                    <span className="text-xs font-medium text-foreground">
                      {t(
                        'auto.components.sidebar.AddRepoHostSelector.addRemoteServer',
                        'Add remote server'
                      )}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t(
                        'auto.components.sidebar.AddRepoHostSelector.addRemoteServerDetail',
                        'Pair with Orca running on another computer.'
                      )}
                    </span>
                  </span>
                </DropdownMenuItem>
                {!wslHostsAcceptNewWork && wslHostsPausedNote ? (
                  <p className="px-2.5 py-1.5 text-2xs text-muted-foreground">
                    {wslHostsPausedNote}
                  </p>
                ) : null}
                {wslHostsAcceptNewWork ? (
                  <DropdownMenuItem onSelect={() => handleOpenAddHost('wsl')}>
                    <span className="flex flex-col items-start gap-0.5 py-0.5">
                      <span className="text-xs font-medium text-foreground">
                        {t(
                          'auto.components.sidebar.AddRepoHostSelector.addWslHost',
                          'Add WSL distro'
                        )}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {t(
                          'auto.components.sidebar.AddRepoHostSelector.addWslHostDetail',
                          'Run an Orca server inside a WSL 2 distro. Experimental.'
                        )}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
