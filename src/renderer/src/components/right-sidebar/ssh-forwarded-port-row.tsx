import React, { useCallback, useState } from 'react'
import { Copy, ExternalLink, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getPortOpenBrowserTooltipLabel } from '@/lib/workspace-port-actions'
import {
  addressForPortForwardEntry,
  advertisedBrowserUrlForForwardedRow
} from '@/lib/workspace-port-urls'
import type { PortForwardEntry } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export function SshForwardedPortRow({
  entry,
  onEdit,
  onOpenInBrowser
}: {
  entry: PortForwardEntry
  onEdit: () => void
  onOpenInBrowser: (event?: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  const [removing, setRemoving] = useState(false)
  const mountedRef = useMountedRef()
  const forwardedAddress = addressForPortForwardEntry(entry)

  const handleRemove = useCallback(async () => {
    setRemoving(true)
    try {
      await window.api.ssh.removePortForward({ id: entry.id })
    } catch {
      // broadcast will update state
    }
    if (mountedRef.current) {
      setRemoving(false)
    }
  }, [entry.id, mountedRef])

  const handleCopy = useCallback(() => {
    void window.api.ui.writeClipboardText(forwardedAddress)
  }, [forwardedAddress])

  const handleOpenBrowser = useCallback(
    (event?: React.MouseEvent<HTMLButtonElement>) => {
      onOpenInBrowser(event)
    },
    [onOpenInBrowser]
  )

  const handleCopyButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      handleCopy()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleCopy]
  )

  const handleOpenBrowserButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // Why: keyboard activations have detail=0; only pointer clicks carry
      // the modifier intent for the system-browser escape hatch.
      handleOpenBrowser(event.detail > 0 ? event : undefined)
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleOpenBrowser]
  )

  const handleEditButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onEdit()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [onEdit]
  )

  const handleRemoveButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      void handleRemove()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleRemove]
  )

  const advertisedBrowserUrl = advertisedBrowserUrlForForwardedRow(entry)
  const openBrowserLabel = translate(
    'auto.components.right.sidebar.PortsPanel.b22b128b2a',
    'Open in Browser'
  )
  const openBrowserTitle = getPortOpenBrowserTooltipLabel(
    advertisedBrowserUrl
      ? translate(
          'auto.components.right.sidebar.PortsPanel.75aeea592f',
          'Open {{value0}} in Browser',
          {
            value0: advertisedBrowserUrl
          }
        )
      : openBrowserLabel
  )

  return (
    <div className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {entry.label && (
            <span className="text-xs font-medium text-foreground truncate">{entry.label}</span>
          )}
          <span
            className={cn(
              'text-xs text-muted-foreground truncate',
              !entry.label && 'text-foreground'
            )}
          >
            :{entry.localPort} → :{entry.remotePort}
          </span>
        </div>
        {advertisedBrowserUrl && (
          <div className="text-[11px] text-muted-foreground/70 truncate">
            {translate('auto.components.right.sidebar.PortsPanel.de349d4560', 'opens {{value0}}', {
              value0: advertisedBrowserUrl
            })}
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleOpenBrowserButtonClick}
          title={openBrowserTitle}
        >
          <ExternalLink size={13} />
        </button>
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleCopyButtonClick}
          title={translate(
            'auto.components.right.sidebar.PortsPanel.1004af16ab',
            'Copy {{value0}}',
            { value0: forwardedAddress }
          )}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleEditButtonClick}
          title={translate('auto.components.right.sidebar.PortsPanel.b3548e59f4', 'Edit')}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className={cn(
            'p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground',
            removing && 'opacity-50'
          )}
          onClick={handleRemoveButtonClick}
          disabled={removing}
          title={translate('auto.components.right.sidebar.PortsPanel.e740075063', 'Remove')}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}
