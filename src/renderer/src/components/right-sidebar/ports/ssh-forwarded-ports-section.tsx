import React, { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { Button } from '@/components/ui/button'
import type {
  PortForwardEntry,
  UnrestoredPortForward
} from '../../../../../shared/remote-runtime/ssh/ssh-types'
import { useTranslate } from '@/i18n/use-translate'
import { SshForwardedPortRow } from './ssh-forwarded-port-row'
import { SshUnrestoredPortRow } from './ssh-unrestored-port-row'
import type { PortForwardDialogState } from './ssh-port-forward-dialog'
import { browserUrlForPortForwardEntry } from '@/lib/workspace-ports/workspace-port-urls'
import { portForwardOwnerKey, type PortForwardOwner } from './port-forward-owner'
import { openForwardedUrlInSystemBrowser } from '@/lib/workspace-ports/forwarded-url-system-browser-open'

const NO_FORWARDS: readonly PortForwardEntry[] = []
const NO_UNRESTORED: readonly UnrestoredPortForward[] = []

export function SshForwardedPortsSection({
  owner,
  canAdd,
  onOpenDialog
}: {
  owner: PortForwardOwner
  /** The owner's connection can start a forward now. */
  canAdd: boolean
  onOpenDialog: (state: PortForwardDialogState) => void
}): React.JSX.Element {
  const t = useTranslate()
  const connectionId = portForwardOwnerKey(owner)
  const forwards = useAppStore((s) => s.portForwardsByConnection[connectionId] ?? NO_FORWARDS)
  // Only SSH hosts save forwards across restarts, so only they have saved forwards that didn't start.
  const unrestored = useAppStore((s) =>
    owner.kind === 'ssh'
      ? (s.unrestoredPortForwardsByConnection[connectionId] ?? NO_UNRESTORED)
      : NO_UNRESTORED
  )
  const count = forwards.length + unrestored.length
  const [collapsed, setCollapsed] = useState(false)

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
            {t('auto.components.right.sidebar.PortsPanel.ddbe58d74e', 'Forwarded')}
          </span>
          {count > 0 && <span className="ml-1 text-[10px] text-muted-foreground/60">{count}</span>}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!canAdd}
          onClick={() => onOpenDialog({ mode: 'add', owner, defaults: {} })}
        >
          <Plus />
          {t('auto.components.right.sidebar.PortsPanel.a103dae837', 'Add')}
        </Button>
      </div>
      {!collapsed &&
        (count > 0 ? (
          <>
            {forwards.map((entry) => (
              <SshForwardedPortRow
                key={entry.id}
                owner={owner}
                entry={entry}
                onEdit={() => onOpenDialog({ mode: 'edit', owner, entry })}
                // Use the system browser: this forward listens locally, while Orca’s browser may run on another host.
                onOpenInBrowser={() =>
                  void openForwardedUrlInSystemBrowser(
                    browserUrlForPortForwardEntry(entry),
                    entry,
                    owner.kind === 'ssh' ? 'ssh' : 'paired'
                  )
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
            {t(
              'auto.components.right.sidebar.PortsPanel.04efd3dad4',
              'Forward a port to access remote services on your local machine.'
            )}
          </p>
        ))}
    </div>
  )
}
