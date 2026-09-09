import React from 'react'
import { advertisedBrowserUrlForDetectedPort } from '@/lib/workspace-port-urls'
import type { EnrichedDetectedPort } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export function SshDetectedPortRow({
  port,
  onForward
}: {
  port: EnrichedDetectedPort & { targetId: string }
  onForward: () => void
}): React.JSX.Element {
  const advertisedBrowserUrl = advertisedBrowserUrlForDetectedPort(port)
  return (
    <div className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-foreground">:{port.port}</span>
          {port.processName && (
            <span className="text-xs text-muted-foreground truncate">{port.processName}</span>
          )}
        </div>
        {advertisedBrowserUrl && (
          <div className="text-[11px] text-muted-foreground/70 truncate">
            {translate(
              'auto.components.right.sidebar.PortsPanel.c7e920aa7c',
              'advertised as {{value0}}',
              { value0: advertisedBrowserUrl }
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="text-[11px] px-2 py-0.5 rounded can-hover:opacity-0 group-hover:opacity-100 transition-opacity bg-accent hover:bg-accent/80 text-foreground"
        onClick={onForward}
      >
        {translate('auto.components.right.sidebar.PortsPanel.c9d106547a', 'Forward')}
      </button>
    </div>
  )
}
