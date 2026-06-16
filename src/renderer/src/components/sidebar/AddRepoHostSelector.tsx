import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { SidebarHostOption } from './sidebar-host-options'
import { getSidebarHostHealthLabel, shouldShowHostScopeControls } from './sidebar-host-options'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { describeRuntimeCompatBlock } from '../../../../shared/protocol-compat'
import { translate } from '@/i18n/i18n'
import { canSelectAddRepoHost } from './add-repo-host-availability'

type AddRepoHostSelectorProps = {
  hosts: SidebarHostOption[]
  selectedHostId: ExecutionHostId
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectHost: (hostId: ExecutionHostId) => void
}

function getHostStatusDetail(host: SidebarHostOption): string {
  if (host.compatibility?.kind === 'blocked') {
    return describeRuntimeCompatBlock(host.compatibility)
  }
  return `${getSidebarHostHealthLabel(host.health)}${host.detail ? ` - ${host.detail}` : ''}`
}

export function AddRepoHostSelector({
  hosts,
  selectedHostId,
  open,
  onOpenChange,
  onSelectHost
}: AddRepoHostSelectorProps): React.JSX.Element | null {
  if (!shouldShowHostScopeControls(hosts)) {
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
                {getSidebarHostHealthLabel(selectedHost.health)}
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
              {hosts.map((host) => {
                const selected = host.id === selectedHostId
                const disabled = !canSelectAddRepoHost(host)
                return (
                  <CommandItem
                    key={host.id}
                    value={`${host.label} ${host.detail}`}
                    disabled={disabled}
                    onSelect={() => {
                      if (disabled) {
                        return
                      }
                      onSelectHost(host.id)
                      onOpenChange(false)
                    }}
                    className={cn(
                      'items-start gap-2 px-3 py-2 text-xs',
                      disabled && 'cursor-not-allowed opacity-55'
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
                        {getHostStatusDetail(host)}
                      </span>
                    </span>
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
