import { useEffect, useState } from 'react'
import { RemoteTerminalPanel } from '@/components/peer-collab/RemoteTerminalPanel'
import type { PeerHostConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'
import { isSameTarget, pruneUngrantedKeepAlive, visitPeersKeepAlive } from './peers-panel-lru'

function isTargetGranted(hosts: PeerHostConnection[], target: RemoteTerminalTarget): boolean {
  const host = hosts.find((h) => h.hostId === target.hostId && h.status.state === 'connected')
  return Boolean(host?.terminals.some((terminal) => terminal.handle === target.handle))
}

/**
 * Renders the visible peer terminal pane. Every target visited this session
 * stays mounted (up to peers-panel-lru's cap) so switching tabs doesn't drop
 * the xterm buffer or the host subscription — only the active pane is shown,
 * the rest are visibility:hidden.
 */
export function PeersPanels({
  hosts,
  primary
}: {
  hosts: PeerHostConnection[]
  primary: RemoteTerminalTarget
}): React.JSX.Element {
  const [mounted, setMounted] = useState<RemoteTerminalTarget[]>([])

  useEffect(() => {
    setMounted((prev) => {
      const granted = pruneUngrantedKeepAlive(prev, (target) => isTargetGranted(hosts, target))
      return isTargetGranted(hosts, primary)
        ? visitPeersKeepAlive(granted, primary, [primary])
        : granted
    })
  }, [hosts, primary])

  return (
    <div className="relative min-h-0 w-full flex-1">
      {mounted.map((target) => {
        const visible = isSameTarget(target, primary)
        return (
          <div
            key={`${target.hostId}:${target.handle}`}
            className="absolute inset-0 overflow-hidden"
            style={{ visibility: visible ? 'visible' : 'hidden', zIndex: visible ? 1 : 0 }}
          >
            <RemoteTerminalPanel
              hostId={target.hostId}
              terminalHandle={target.handle}
              hidden={!visible}
            />
          </div>
        )
      })}
    </div>
  )
}
