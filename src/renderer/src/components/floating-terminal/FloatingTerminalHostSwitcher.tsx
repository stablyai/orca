import { Monitor, Server } from 'lucide-react'
import { useAppStore } from '@/store'
import { useFloatingWorkspaceHost } from '@/lib/floating-workspace-host'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

export function FloatingTerminalHostSwitcher(): React.JSX.Element | null {
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const environmentId = useFloatingWorkspaceHost((state) => state.environmentId)
  const selectHost = useFloatingWorkspaceHost((state) => state.selectHost)
  if (environments.length === 0 && !environmentId) {
    return null
  }
  const selectedHost = environments.find((host) => host.id === environmentId)
  const unavailableHost = translate('remoteFloatingTerminal.unavailableHost', 'Unavailable host')
  const hostName = environmentId ? (selectedHost?.name ?? unavailableHost) : 'Local'
  const hostLabel = translate('remoteFloatingTerminal.host', 'Host')
  const HostIcon = environmentId ? Server : Monitor
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-xs" aria-label={`${hostLabel}: ${hostName}`}>
              <HostIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{`${hostLabel}: ${hostName}`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        data-floating-terminal-no-drag
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel>{hostLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={environmentId ?? 'local'}
          onValueChange={(value) => selectHost(value === 'local' ? null : value)}
        >
          <DropdownMenuRadioItem value="local">Local</DropdownMenuRadioItem>
          {environmentId && !selectedHost ? (
            <DropdownMenuRadioItem value={environmentId} disabled>
              {unavailableHost}
            </DropdownMenuRadioItem>
          ) : null}
          {environments.map((host) => (
            <DropdownMenuRadioItem key={host.id} value={host.id}>
              {host.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
