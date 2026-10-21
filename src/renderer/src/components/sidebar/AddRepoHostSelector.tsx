import { useState } from 'react'
import { Check, ChevronRight, ChevronsUpDown, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { SidebarHostOption } from './sidebar-host-options'
import { getSidebarHostHealthLabel, shouldShowHostScopeControls } from './sidebar-host-options'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { describeRuntimeCompatBlock } from '../../../../shared/protocol-compat'
import { translate } from '@/i18n/i18n'
import { canConnectAddRepoHost, canSelectAddRepoHost } from './add-repo-host-availability'

type AddRepoHostSelectorProps = {
  hosts: SidebarHostOption[]
  selectedHostId: ExecutionHostId | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectHost: (hostId: ExecutionHostId) => void
  onConnectHost?: (hostId: ExecutionHostId) => void
  onAddSshHost?: () => void
  onAddRemoteServer?: () => void
  /** Present only where WSL hosts are available and turned on. */
  onAddWslHost?: () => void
  /** Opens Experimental → WSL distros as hosts, for a WSL host listed while that is off. */
  onOpenWslHostsSetting?: () => void
}

function getHostStatusDetail(host: SidebarHostOption): string {
  // Why only the detail: "Disconnected" would read as a failure, not a switched-off feature.
  if (host.wslUnavailable) {
    return host.detail
  }
  if (host.compatibility?.kind === 'blocked') {
    return describeRuntimeCompatBlock(host.compatibility)
  }
  return `${getSidebarHostHealthLabel(host.health, host.blockedReason)}${host.detail ? ` - ${host.detail}` : ''}`
}

export function AddRepoHostSelector({
  hosts,
  selectedHostId,
  open,
  onOpenChange,
  onSelectHost,
  onConnectHost,
  onAddSshHost,
  onAddRemoteServer,
  onAddWslHost,
  onOpenWslHostsSetting
}: AddRepoHostSelectorProps): React.JSX.Element | null {
  const [addHostOpen, setAddHostOpen] = useState(false)
  const showHostSetupActions = Boolean(onAddSshHost || onAddRemoteServer || onAddWslHost)
  if (!shouldShowHostScopeControls(hosts) && !showHostSetupActions) {
    return null
  }

  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0]
  if (!selectedHost) {
    return null
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-medium text-muted-foreground">
        {translate('auto.components.sidebar.AddRepoHostSelector.host', 'Host')}
      </span>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            role="combobox"
            aria-expanded={open}
            className="h-7 min-w-0 max-w-[18rem] gap-1.5 rounded-md border border-border bg-muted/30 px-2 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <span className="min-w-0 truncate">{selectedHost.label}</span>
            {selectedHost.health !== 'local' ? (
              <span
                title={getHostStatusDetail(selectedHost)}
                className="shrink-0 text-[11px] font-normal text-muted-foreground"
              >
                {getSidebarHostHealthLabel(selectedHost.health, selectedHost.blockedReason)}
              </span>
            ) : null}
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(340px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
        >
          <Command>
            <CommandList>
              {showHostSetupActions ? (
                <Popover open={addHostOpen} onOpenChange={setAddHostOpen}>
                  <PopoverTrigger asChild>
                    <CommandItem
                      value="Add remote host SSH host Orca server"
                      onSelect={() => setAddHostOpen(true)}
                      className="items-start gap-2 px-3 py-2 text-xs text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
                    >
                      <Plus className="mt-0.5 size-3 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">
                            {translate(
                              'auto.components.sidebar.AddRepoHostSelector.addRemoteHost',
                              'Add remote host'
                            )}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {onAddWslHost
                            ? translate(
                                'auto.components.sidebar.AddRepoHostSelector.addRemoteHostDetailWithWsl',
                                'SSH host, Orca server, or WSL distro'
                              )
                            : translate(
                                'auto.components.sidebar.AddRepoHostSelector.addRemoteHostDetail',
                                'SSH host or Orca server'
                              )}
                        </span>
                      </span>
                      <ChevronRight className="mt-0.5 size-3.5 shrink-0" />
                    </CommandItem>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="right" className="w-72 p-1" sideOffset={8}>
                    {onAddSshHost ? (
                      <button
                        type="button"
                        className="flex w-full flex-col rounded-sm px-2.5 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={() => {
                          setAddHostOpen(false)
                          onOpenChange(false)
                          onAddSshHost()
                        }}
                      >
                        <span className="text-xs font-medium">
                          {translate(
                            'auto.components.sidebar.AddRepoHostSelector.addSshHost',
                            'Add SSH host'
                          )}
                        </span>
                        <span className="mt-0.5 text-[11px] text-muted-foreground">
                          {translate(
                            'auto.components.sidebar.AddRepoHostSelector.addSshHostDetail',
                            'Use an existing machine over SSH.'
                          )}
                        </span>
                      </button>
                    ) : null}
                    {onAddRemoteServer ? (
                      <button
                        type="button"
                        className="flex w-full flex-col rounded-sm px-2.5 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={() => {
                          setAddHostOpen(false)
                          onOpenChange(false)
                          onAddRemoteServer()
                        }}
                      >
                        <span className="text-xs font-medium">
                          {translate(
                            'auto.components.sidebar.AddRepoHostSelector.addRemoteServer',
                            'Add remote server'
                          )}
                        </span>
                        <span className="mt-0.5 text-[11px] text-muted-foreground">
                          {translate(
                            'auto.components.sidebar.AddRepoHostSelector.addRemoteServerDetail',
                            'Pair with Orca running on another computer.'
                          )}
                        </span>
                      </button>
                    ) : null}
                    {onAddWslHost ? (
                      <button
                        type="button"
                        className="flex w-full flex-col rounded-sm px-2.5 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={() => {
                          setAddHostOpen(false)
                          onOpenChange(false)
                          onAddWslHost()
                        }}
                      >
                        <span className="text-xs font-medium">
                          {translate(
                            'auto.components.sidebar.AddRepoHostSelector.addWslHost',
                            'Add WSL distro'
                          )}
                        </span>
                        <span className="mt-0.5 text-[11px] text-muted-foreground">
                          {translate(
                            'auto.components.sidebar.AddRepoHostSelector.addWslHostDetail',
                            'Run an Orca server inside a WSL 2 distro. Experimental.'
                          )}
                        </span>
                      </button>
                    ) : null}
                  </PopoverContent>
                </Popover>
              ) : null}
              {hosts.map((host) => {
                const selected = host.id === selectedHostId
                const disabled = !canSelectAddRepoHost(host)
                const canConnectHost = canConnectAddRepoHost(host)
                const canTurnOn =
                  host.wslUnavailable === 'turned-off' && onOpenWslHostsSetting !== undefined
                // Why one flag: either action keeps the otherwise unselectable row interactive.
                const canConnect = canConnectHost || canTurnOn
                const isConnecting = host.health === 'connecting'
                return (
                  <CommandItem
                    key={host.id}
                    value={`${host.label} ${host.detail}`}
                    disabled={disabled && !canConnect}
                    aria-disabled={disabled}
                    onSelect={() => {
                      if (disabled) {
                        return
                      }
                      onSelectHost(host.id)
                      onOpenChange(false)
                    }}
                    className={cn(
                      'items-start gap-2 px-3 py-2 text-xs',
                      disabled && !canConnect && 'cursor-not-allowed opacity-55'
                    )}
                  >
                    <Check
                      className={cn(
                        'mt-0.5 size-3 text-muted-foreground',
                        selected ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{host.label}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        <span className="min-w-0 flex-1 truncate">{getHostStatusDetail(host)}</span>
                      </span>
                    </span>
                    {canConnectHost ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="ml-2 h-auto w-[5.75rem] shrink-0 justify-end gap-1 self-center px-0 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground hover:no-underline"
                        disabled={isConnecting}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onConnectHost?.(host.id)
                        }}
                      >
                        {isConnecting ? <Loader2 className="size-3 animate-spin" /> : null}
                        {isConnecting
                          ? translate(
                              'auto.components.sidebar.AddRepoHostSelector.connecting',
                              'Connecting'
                            )
                          : translate(
                              'auto.components.sidebar.AddRepoHostSelector.connect',
                              'Connect'
                            )}
                      </Button>
                    ) : canTurnOn ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="ml-2 self-center"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onOpenChange(false)
                          onOpenWslHostsSetting()
                        }}
                      >
                        {translate(
                          'auto.components.sidebar.AddRepoHostSelector.turnOnWslHosts',
                          'Turn on'
                        )}
                      </Button>
                    ) : null}
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
