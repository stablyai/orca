import { Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function PeersEmptyState({
  kind,
  onOpenSettings
}: {
  kind: 'disconnected' | 'no-terminals'
  onOpenSettings: () => void
}): React.JSX.Element {
  const title =
    kind === 'disconnected'
      ? translate('auto.components.peers.PeersEmptyState.f3a8c1d0e5', 'Not connected to a host')
      : translate('auto.components.peers.PeersEmptyState.b6d2e9f4a7', 'No terminals shared yet')
  const description =
    kind === 'disconnected'
      ? translate(
          'auto.components.peers.PeersEmptyState.c9e4b7a1d3',
          'Pair with another Orca desktop to view its shared terminals here.'
        )
      : translate(
          'auto.components.peers.PeersEmptyState.d1f6a3c8e2',
          'Ask the host to share a terminal with you, or check your pairing in Settings.'
        )

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Unplug className="size-7 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onOpenSettings}>
        {translate('auto.components.peers.PeersEmptyState.e2a5d8b9c4', 'Open Settings')}
      </Button>
    </div>
  )
}
