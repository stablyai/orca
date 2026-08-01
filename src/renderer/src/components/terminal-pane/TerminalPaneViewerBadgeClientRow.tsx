import { Eye, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import type { ConnectedPeerClient } from '@/components/settings/PeerCollabConnectedClientsSection'

type TerminalPaneViewerBadgeClientRowProps = {
  client: ConnectedPeerClient
  handle: string
  isWatching: boolean
  onToggleGrant: (deviceId: string, next: string[]) => void
  onDisconnect: (deviceId: string) => void
}

/** One row in the viewer badge popover: identity, share toggle, watching state, disconnect. */
export function TerminalPaneViewerBadgeClientRow({
  client,
  handle,
  isWatching,
  onToggleGrant,
  onDisconnect
}: TerminalPaneViewerBadgeClientRowProps): React.JSX.Element {
  const granted = client.grantedTerminals.includes(handle)

  function handleGrantChange(checked: boolean): void {
    onToggleGrant(
      client.deviceId,
      checked
        ? [...client.grantedTerminals, handle]
        : client.grantedTerminals.filter((h) => h !== handle)
    )
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-sm px-1.5 py-1">
      <label className="flex min-w-0 items-center gap-2">
        <Checkbox
          checked={granted}
          onCheckedChange={(checked) => handleGrantChange(checked === true)}
          aria-label={translate(
            'components.terminalPaneViewerBadge.shareToggle',
            'Share this terminal with {{name}}',
            { name: client.name }
          )}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-1 truncate text-xs font-medium">
            {client.name}
            {isWatching ? <Eye className="text-muted-foreground size-3 shrink-0" /> : null}
          </div>
          <div className="text-muted-foreground text-[11px]">
            {new Date(client.connectedAt).toLocaleTimeString()}
          </div>
        </div>
      </label>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        title={translate('components.terminalPaneViewerBadge.disconnect', 'Disconnect')}
        onClick={() => onDisconnect(client.deviceId)}
      >
        <Unplug className="size-3" />
      </Button>
    </div>
  )
}
