import { RadioTower } from 'lucide-react'
import type { MobileReverseTunnelEntry } from '../../../../shared/mobile-reverse-tunnel'
import { Button } from '../ui/button'
import { MobileRemoteAccessForm } from './MobileRemoteAccessForm'
import { useMobileRemoteAccessState } from './mobile-remote-access-state'
import { translate } from '@/i18n/i18n'

type MobileRemoteAccessSectionProps = {
  onGenerateTunnelQr: (address: string) => void
  loadingQr: boolean
}

function tunnelStatusLabel(tunnel: MobileReverseTunnelEntry | null): string {
  if (!tunnel) {
    return translate('auto.components.settings.MobileRemoteAccessSection.31d88d6000', 'Not running')
  }
  if (tunnel.status === 'starting') {
    return translate('auto.components.settings.MobileRemoteAccessSection.d48c2a62a4', 'Starting')
  }
  if (tunnel.status === 'running') {
    return translate('auto.components.settings.MobileRemoteAccessSection.684ad62309', 'Running')
  }
  if (tunnel.status === 'stopping') {
    return translate('auto.components.settings.MobileRemoteAccessSection.f2a7a9e55f', 'Stopping')
  }
  return translate('auto.components.settings.MobileRemoteAccessSection.18968ede9e', 'Failed')
}

export function MobileRemoteAccessSection({
  onGenerateTunnelQr,
  loadingQr
}: MobileRemoteAccessSectionProps): React.JSX.Element {
  const remoteAccess = useMobileRemoteAccessState({ onGenerateTunnelQr })

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <RadioTower className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {translate(
            'auto.components.settings.MobileRemoteAccessSection.0f52c8c0de',
            'Remote Access'
          )}
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.MobileRemoteAccessSection.f8f4a4317a',
          'Use a saved SSH key target to open a reverse tunnel through a public server, then generate a mobile QR code with that public address.'
        )}
      </p>

      <div className="space-y-3">
        <MobileRemoteAccessForm
          targets={remoteAccess.targets}
          selectedTargetId={remoteAccess.selectedTargetId}
          publicHost={remoteAccess.publicHost}
          remotePort={remoteAccess.remotePort}
          localPort={remoteAccess.localPort}
          activeTunnel={remoteAccess.activeTunnel}
          loadingTargets={remoteAccess.loadingTargets}
          startingTunnel={remoteAccess.startingTunnel}
          stoppingTunnel={remoteAccess.stoppingTunnel}
          testingEndpoint={remoteAccess.testingEndpoint}
          canStart={remoteAccess.canStart}
          canTest={remoteAccess.canTest}
          loadingQr={loadingQr}
          onSelectedTargetIdChange={remoteAccess.setSelectedTargetId}
          onPublicHostChange={remoteAccess.setPublicHost}
          onRemotePortChange={remoteAccess.setRemotePort}
          onLocalPortChange={remoteAccess.setLocalPort}
          onRefreshTargets={() => void remoteAccess.loadTargets()}
          onStartTunnel={() => void remoteAccess.startTunnel()}
          onStopTunnel={() => void remoteAccess.stopTunnel()}
          onTestEndpoint={() => void remoteAccess.testEndpoint()}
          onGenerateQr={() =>
            remoteAccess.activeTunnel &&
            onGenerateTunnelQr(remoteAccess.activeTunnel.advertisedAddress)
          }
        />

        <div className="rounded-md border border-border/60 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted-foreground">
              {translate(
                'auto.components.settings.MobileRemoteAccessSection.4c390a3c74',
                'Tunnel status:'
              )}
            </span>
            <span className="font-medium">{tunnelStatusLabel(remoteAccess.activeTunnel)}</span>
            {remoteAccess.activeTunnel ? (
              <span className="font-mono text-muted-foreground">
                {remoteAccess.activeTunnel.advertisedAddress}
              </span>
            ) : remoteAccess.selectedTarget ? (
              <span className="text-muted-foreground">
                {translate(
                  'auto.components.settings.MobileRemoteAccessSection.a2d0f184a1',
                  'Select a public host and start the tunnel.'
                )}
              </span>
            ) : (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 py-0 text-xs"
                onClick={() => void remoteAccess.importTargets()}
                disabled={remoteAccess.loadingTargets}
              >
                {translate(
                  'auto.components.settings.MobileRemoteAccessSection.bcefbeaa4f',
                  'Import SSH config'
                )}
              </Button>
            )}
          </div>
          {remoteAccess.activeTunnel?.error ? (
            <p className="mt-1 text-muted-foreground">{remoteAccess.activeTunnel.error}</p>
          ) : (
            <p className="mt-1 text-muted-foreground">
              {translate(
                'auto.components.settings.MobileRemoteAccessSection.d6d97cf30b',
                'The server must allow AllowTcpForwarding and GatewayPorts, and its firewall must expose the selected port.'
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
