import { useEffect, useState } from 'react'
import type { TailnetPeerSuggestion } from '../../../../shared/tailnet-peers'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

// Why: large corporate tailnets can have dozens of peers; cap the chips so the
// form stays a form. The remainder is still reachable by typing the host.
const MAX_SUGGESTED_PEERS = 8

type TailnetPeerSuggestionSectionProps = {
  onPick: (peer: TailnetPeerSuggestion) => void
}

export function TailnetPeerSuggestionSection({
  onPick
}: TailnetPeerSuggestionSectionProps): React.JSX.Element | null {
  const [peers, setPeers] = useState<TailnetPeerSuggestion[]>([])
  const mountedRef = useMountedRef()

  useEffect(() => {
    void (async () => {
      try {
        const discovery = await window.api.tailscale.discoverPeers()
        if (!mountedRef.current) {
          return
        }
        // Why: offline peers can't be reached, so suggesting them invites
        // connects that are guaranteed to fail.
        setPeers(discovery.peers.filter((peer) => peer.online))
      } catch {
        // No Tailscale on this machine — the section simply stays hidden.
      }
    })()
  }, [mountedRef])

  if (peers.length === 0) {
    return null
  }

  const visiblePeers = peers.slice(0, MAX_SUGGESTED_PEERS)
  const hiddenCount = peers.length - visiblePeers.length

  return (
    <div className="col-span-2 space-y-1.5">
      <Label>
        {translate(
          'auto.components.settings.TailnetPeerSuggestionSection.7a2f6fb0a5',
          'Tailscale peers'
        )}
      </Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {visiblePeers.map((peer) => (
          <Button
            key={peer.dnsName || peer.ipv4 || peer.hostName}
            type="button"
            variant="outline"
            size="sm"
            title={[peer.dnsName || peer.ipv4, peer.os].filter(Boolean).join(' · ')}
            onClick={() => onPick(peer)}
          >
            {peer.hostName}
          </Button>
        ))}
        {hiddenCount > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.TailnetPeerSuggestionSection.60d02530dc',
              '+{{count}} more on your tailnet',
              { count: hiddenCount }
            )}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.TailnetPeerSuggestionSection.c812f9f26b',
          'Online machines on your tailnet. Click one to prefill the form.'
        )}
      </p>
    </div>
  )
}
