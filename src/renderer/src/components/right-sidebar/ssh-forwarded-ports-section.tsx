import React, { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { PortForwardEntry, UnrestoredPortForward } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { SshForwardedPortRow } from './ssh-forwarded-port-row'
import { SshUnrestoredPortRow } from './ssh-unrestored-port-row'
import { SshPortForwardDialog, type PortForwardDialogState } from './ssh-port-forward-dialog'
import { browserUrlForPortForwardEntry } from '@/lib/workspace-port-urls'

const NO_FORWARDS: readonly PortForwardEntry[] = []
const NO_UNRESTORED: readonly UnrestoredPortForward[] = []

export function SshForwardedPortsSection({
  connectionId
}: {
  connectionId: string
}): React.JSX.Element {
  const forwards = useAppStore((s) => s.portForwardsByConnection[connectionId] ?? NO_FORWARDS)
  const unrestored = useAppStore(
    (s) => s.unrestoredPortForwardsByConnection[connectionId] ?? NO_UNRESTORED
  )
  const count = forwards.length + unrestored.length
  const connected = useAppStore(
    (s) => s.sshConnectionStates.get(connectionId)?.status === 'connected'
  )
  const [collapsed, setCollapsed] = useState(false)
  const [dialogState, setDialogState] = useState<PortForwardDialogState>({ mode: 'closed' })

  return (
    <div className="px-3 pt-2" data-ssh-forwarded-ports="">
      <div className="mb-1 flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <ChevronRight
            size={12}
            className={cn('text-muted-foreground transition-transform', !collapsed && 'rotate-90')}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.ddbe58d74e', 'Forwarded')}
          </span>
          {count > 0 && <span className="ml-1 text-[10px] text-muted-foreground/60">{count}</span>}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!connected}
          onClick={() => setDialogState({ mode: 'add', defaults: { targetId: connectionId } })}
        >
          <Plus />
          {translate('auto.components.right.sidebar.PortsPanel.a103dae837', 'Add')}
        </Button>
      </div>
      {!collapsed &&
        (count > 0 ? (
          <>
            {forwards.map((entry) => (
              <SshForwardedPortRow
                key={entry.id}
                entry={entry}
                onEdit={() => setDialogState({ mode: 'edit', entry })}
                // Use the system browser: this forward listens locally, while Orca’s browser may run on another host.
                onOpenInBrowser={() =>
                  void window.api.shell.openUrl(browserUrlForPortForwardEntry(entry))
                }
              />
            ))}
            {unrestored.map((forward) => (
              <SshUnrestoredPortRow
                key={`${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`}
                targetId={connectionId}
                forward={forward}
              />
            ))}
          </>
        ) : (
          <p className="py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.PortsPanel.04efd3dad4',
              'Forward a port to access remote services on your local machine.'
            )}
          </p>
        ))}
      <SshPortForwardDialog
        state={dialogState}
        activeConnectionId={connectionId}
        onClose={() => setDialogState({ mode: 'closed' })}
      />
    </div>
  )
}
