import { KeyRound, Loader2, RefreshCw, Server, Square, TestTube2 } from 'lucide-react'
import type { MobileReverseTunnelEntry } from '../../../../shared/mobile-reverse-tunnel'
import type { SshTarget } from '../../../../shared/ssh-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { formatMobileRemoteTargetLabel } from './mobile-remote-access-state'
import { translate } from '@/i18n/i18n'

type MobileRemoteAccessFormProps = {
  targets: SshTarget[]
  selectedTargetId: string
  publicHost: string
  remotePort: string
  localPort: string
  activeTunnel: MobileReverseTunnelEntry | null
  loadingTargets: boolean
  startingTunnel: boolean
  stoppingTunnel: boolean
  testingEndpoint: boolean
  canStart: boolean
  canTest: boolean
  loadingQr: boolean
  onSelectedTargetIdChange: (targetId: string) => void
  onPublicHostChange: (host: string) => void
  onRemotePortChange: (port: string) => void
  onLocalPortChange: (port: string) => void
  onRefreshTargets: () => void
  onStartTunnel: () => void
  onStopTunnel: () => void
  onTestEndpoint: () => void
  onGenerateQr: () => void
}

export function MobileRemoteAccessForm({
  targets,
  selectedTargetId,
  publicHost,
  remotePort,
  localPort,
  activeTunnel,
  loadingTargets,
  startingTunnel,
  stoppingTunnel,
  testingEndpoint,
  canStart,
  canTest,
  loadingQr,
  onSelectedTargetIdChange,
  onPublicHostChange,
  onRemotePortChange,
  onLocalPortChange,
  onRefreshTargets,
  onStartTunnel,
  onStopTunnel,
  onTestEndpoint,
  onGenerateQr
}: MobileRemoteAccessFormProps): React.JSX.Element {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px_120px]">
        <div className="space-y-1">
          <Label htmlFor="mobile-remote-ssh-target">
            {translate(
              'auto.components.settings.MobileRemoteAccessSection.f8a8fc7df8',
              'SSH target'
            )}
          </Label>
          <div className="flex min-w-0 items-center gap-2">
            <Select value={selectedTargetId} onValueChange={onSelectedTargetIdChange}>
              <SelectTrigger id="mobile-remote-ssh-target" size="sm" className="min-w-0 flex-1">
                <SelectValue
                  placeholder={translate(
                    'auto.components.settings.MobileRemoteAccessSection.29b8fd81b0',
                    'No SSH targets'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {formatMobileRemoteTargetLabel(target)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onRefreshTargets}
                  disabled={loadingTargets}
                  aria-label={translate(
                    'auto.components.settings.MobileRemoteAccessSection.b16483c176',
                    'Refresh SSH targets'
                  )}
                  className="text-muted-foreground"
                >
                  <RefreshCw className={loadingTargets ? 'animate-spin' : ''} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate(
                  'auto.components.settings.MobileRemoteAccessSection.b16483c176',
                  'Refresh SSH targets'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="mobile-remote-public-host">
            {translate(
              'auto.components.settings.MobileRemoteAccessSection.d8abffec10',
              'Public host'
            )}
          </Label>
          <Input
            id="mobile-remote-public-host"
            value={publicHost}
            onChange={(event) => onPublicHostChange(event.target.value)}
            placeholder={translate(
              'auto.components.settings.MobileRemoteAccessSection.3ac60f0235',
              'server.example.com'
            )}
            className="h-8 font-mono text-xs"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="mobile-remote-port">
            {translate(
              'auto.components.settings.MobileRemoteAccessSection.7879ab7ccc',
              'Public port'
            )}
          </Label>
          <Input
            id="mobile-remote-port"
            value={remotePort}
            onChange={(event) => onRemotePortChange(event.target.value)}
            inputMode="numeric"
            className="h-8 font-mono text-xs"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <div className="space-y-1">
          <Label htmlFor="mobile-remote-local-port">
            {translate(
              'auto.components.settings.MobileRemoteAccessSection.62ca6d3a7d',
              'Local runtime port'
            )}
          </Label>
          <Input
            id="mobile-remote-local-port"
            value={localPort}
            onChange={(event) => onLocalPortChange(event.target.value)}
            inputMode="numeric"
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button
            type="button"
            size="sm"
            className="w-[116px] gap-1.5"
            disabled={!canStart}
            onClick={onStartTunnel}
          >
            {startingTunnel ? <Loader2 className="size-3.5 animate-spin" /> : <Server />}
            {translate('auto.components.settings.MobileRemoteAccessSection.9f023b53e6', 'Start')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-[92px] gap-1.5"
            disabled={!activeTunnel || stoppingTunnel}
            onClick={onStopTunnel}
          >
            {stoppingTunnel ? <Loader2 className="size-3.5 animate-spin" /> : <Square />}
            {translate('auto.components.settings.MobileRemoteAccessSection.a0d4f95c12', 'Stop')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-[92px] gap-1.5"
            disabled={testingEndpoint || !canTest}
            onClick={onTestEndpoint}
          >
            {testingEndpoint ? <Loader2 className="size-3.5 animate-spin" /> : <TestTube2 />}
            {translate('auto.components.settings.MobileRemoteAccessSection.317c97a5c7', 'Test')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!activeTunnel || loadingQr}
            onClick={onGenerateQr}
          >
            {loadingQr ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound />}
            {translate(
              'auto.components.settings.MobileRemoteAccessSection.276a5499f9',
              'Generate QR'
            )}
          </Button>
        </div>
      </div>
    </>
  )
}
