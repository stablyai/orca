import React from 'react'
import { Loader2, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useWorktreeHostConnection } from '@/lib/worktree-host-connection-phase'
import { useUserDisconnectedHostConnect } from '@/ssh/use-user-disconnected-host-connect'

type FileExplorerTreeStatusProps = {
  /** The listed workspace; lets the status say when the user's Disconnect holds its host down. */
  worktreeId: string | null
  isLoading: boolean
  error: string | null
  isEmpty: boolean
  emptyMessage?: string
}

export function FileExplorerTreeStatus({
  worktreeId,
  isLoading,
  error,
  isEmpty,
  emptyMessage
}: FileExplorerTreeStatusProps): React.JSX.Element | null {
  const host = useWorktreeHostConnection(worktreeId)
  const userDisconnectedHost = useUserDisconnectedHostConnect(host)
  // Why a connecting host shows as loading: its read error belongs to the connection it is
  // replacing, and the tree reloads once it connects.
  if (isLoading || (error && host.phase === 'connecting')) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  if (error && userDisconnectedHost) {
    // Why not the raw read error: the user's own Disconnect is why the read failed, and the tree
    // reloads on its own once they connect.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground">
        <ServerOff className="size-4" />
        <div className="font-medium text-foreground">
          {translate(
            'auto.components.right.sidebar.FileExplorerTreeStatus.userDisconnectedTitle',
            'You disconnected {{host}}',
            { host: userDisconnectedHost.hostLabel }
          )}
        </div>
        <div>
          {translate(
            'auto.components.right.sidebar.FileExplorerTreeStatus.userDisconnectedDescription',
            "Connect it to show this workspace's files."
          )}
        </div>
        <Button
          type="button"
          size="xs"
          disabled={userDisconnectedHost.connecting}
          onClick={userDisconnectedHost.connect}
        >
          {translate('auto.components.right.sidebar.FileExplorerTreeStatus.connect', 'Connect')}
        </Button>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.FileExplorerTreeStatus.c76693e456',
          'Could not load files for this workspace:'
        )}{' '}
        {error}
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {emptyMessage ??
          translate(
            'auto.components.right.sidebar.FileExplorerTreeStatus.ce03835e1f',
            'No files in this workspace'
          )}
      </div>
    )
  }

  return null
}
