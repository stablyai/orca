import React, { useCallback, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { UnrestoredPortForward } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

/** A saved forward that isn't open, e.g. its local port is taken; removable so it stops retrying. */
export function SshUnrestoredPortRow({
  targetId,
  forward
}: {
  targetId: string
  forward: UnrestoredPortForward
}): React.JSX.Element {
  const [removing, setRemoving] = useState(false)
  const mountedRef = useMountedRef()

  const handleRemove = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
      setRemoving(true)
      try {
        await window.api.ssh.removeSavedPortForward({
          targetId,
          localPort: forward.localPort,
          remoteHost: forward.remoteHost,
          remotePort: forward.remotePort
        })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
      if (mountedRef.current) {
        setRemoving(false)
      }
    },
    [forward.localPort, forward.remoteHost, forward.remotePort, mountedRef, targetId]
  )

  return (
    <div
      className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors"
      data-ssh-unrestored-forward=""
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {forward.label && (
            <span className="text-xs font-medium text-muted-foreground truncate">
              {forward.label}
            </span>
          )}
          <span className="text-xs text-muted-foreground truncate">
            :{forward.localPort} → :{forward.remotePort}
          </span>
        </div>
        <div
          className={cn(
            'text-[11px] truncate',
            forward.error ? 'text-destructive' : 'text-muted-foreground/70'
          )}
          title={forward.error}
        >
          {forward.error
            ? forward.stopped
              ? translate(
                  'auto.components.right.sidebar.ssh.unrestored.port.row.b817a96fcf',
                  'Stopped: {{value0}}',
                  { value0: forward.error }
                )
              : translate(
                  'auto.components.right.sidebar.ssh.unrestored.port.row.04adb5f5e7',
                  "Couldn't start: {{value0}}",
                  { value0: forward.error }
                )
            : translate(
                'auto.components.right.sidebar.ssh.unrestored.port.row.4c119f5e2a',
                'Not started yet'
              )}
        </div>
      </div>
      <button
        type="button"
        className={cn(
          'p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground',
          removing && 'opacity-50'
        )}
        onClick={(event) => void handleRemove(event)}
        disabled={removing}
        aria-label={translate('auto.components.right.sidebar.PortsPanel.e740075063', 'Remove')}
        title={translate('auto.components.right.sidebar.PortsPanel.e740075063', 'Remove')}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
