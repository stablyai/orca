import { XIcon } from 'lucide-react'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import type { PeerClientStatus } from '../../../../shared/peer-client-status'
import { RemoteTerminalPanel } from './RemoteTerminalPanel'
import { translate } from '@/i18n/i18n'

export type RemoteTerminalDialogTarget = {
  handle: string
  title: string
}

function connectionBadgeLabel(state: PeerClientStatus['state']): string {
  if (state === 'connected') {
    return translate('auto.components.peer-collab.RemoteTerminalDialog.connected', 'Connected')
  }
  if (state === 'reconnect-wait') {
    return translate(
      'auto.components.peer-collab.RemoteTerminalDialog.reconnecting',
      'Reconnecting'
    )
  }
  return translate('auto.components.peer-collab.RemoteTerminalDialog.disconnected', 'Disconnected')
}

/** Near-fullscreen dialog for one remote terminal, opened from the host
 *  terminal list in the Peer Collaboration settings pane. */
export function RemoteTerminalDialog({
  target,
  hostLabel,
  clientStatus,
  onOpenChange
}: {
  target: RemoteTerminalDialogTarget | null
  hostLabel: string
  clientStatus: PeerClientStatus
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      {target ? (
        <DialogContent
          aria-describedby={undefined}
          className="flex w-[calc(100vw-40px)] max-w-none flex-col gap-0 p-0 sm:max-w-none"
          showCloseButton={false}
          onEscapeKeyDown={(e) => {
            if (e.target instanceof HTMLElement && e.target.closest('.xterm')) {
              e.preventDefault()
            }
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-2">
            <DialogTitle className="text-[12px] leading-normal font-semibold">
              {target.title}
            </DialogTitle>
            <span className="text-[11px] text-muted-foreground">{hostLabel}</span>
            <Badge variant="outline" className="text-[11px]">
              {connectionBadgeLabel(clientStatus.state)}
            </Badge>
            <DialogClose className="ml-auto rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-hidden">
              <XIcon className="size-4" />
              <span className="sr-only">
                {translate('auto.components.peer-collab.RemoteTerminalDialog.close', 'Close')}
              </span>
            </DialogClose>
          </div>
          <RemoteTerminalPanel terminalHandle={target.handle} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
