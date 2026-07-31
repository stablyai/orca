import React from 'react'
import { useAppStore } from '@/store'
import { usePeerCollabClientConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

// Why: a client is paired to exactly one host at a time, so this renders at most one host group.
function PeerTerminalsSection(): React.JSX.Element | null {
  const { hostTerminals, clientStatus } = usePeerCollabClientConnection()
  const peersPageTarget = useAppStore((s) => s.peersPageTarget)
  const openPeersPage = useAppStore((s) => s.openPeersPage)

  if (clientStatus.state !== 'connected') {
    return null
  }

  // Why: the host has no display-name field over the pairing wire yet — endpoint
  // is the only identifier the client side has, same as the Settings pane's usage.
  const hostLabel =
    clientStatus.endpoint ??
    translate('auto.components.sidebar.PeerTerminalsSection.dd7ecb3f10', 'Connected host')

  return (
    <div className="mt-3 flex shrink-0 flex-col">
      <div className="mt-2 flex h-8 items-center px-2">
        <span
          className="pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none"
          data-sidebar-section-title="peers"
        >
          {translate('auto.components.sidebar.PeerTerminalsSection.f966803cfd', 'Peers')}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-2 pb-2">
        <div className="truncate px-2 pb-1 text-xs font-medium text-worktree-sidebar-foreground/70">
          {hostLabel}
        </div>
        {hostTerminals.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.PeerTerminalsSection.d5f6851245',
              'No terminals shared yet'
            )}
          </p>
        ) : (
          hostTerminals.map((terminal) => {
            const title =
              terminal.title ||
              translate(
                'auto.components.sidebar.PeerTerminalsSection.4fd5f4c027',
                'Untitled terminal'
              )
            const isSelected = peersPageTarget?.handle === terminal.handle
            return (
              <button
                key={terminal.handle}
                type="button"
                data-current={isSelected}
                onClick={() => openPeersPage({ handle: terminal.handle, title })}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-worktree-sidebar-accent',
                  isSelected && 'bg-worktree-sidebar-accent'
                )}
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    isSelected
                      ? 'bg-worktree-sidebar-foreground'
                      : 'border border-muted-foreground/50'
                  )}
                />
                <span className="truncate">{title}</span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export default React.memo(PeerTerminalsSection)
