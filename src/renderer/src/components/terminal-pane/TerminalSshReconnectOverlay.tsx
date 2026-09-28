import { useCallback } from 'react'
import { Loader2, Server, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import { canConnectSshStatus, isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { sshConnectingLabel, sshConnectVerb } from '@/ssh/ssh-connect-verb'
import { useSshConnectInFlight } from '@/ssh/ssh-connect-in-flight'
import { connectSshTargetForUser } from '@/ssh/ssh-user-connect'

type TerminalSshReconnectOverlayProps = {
  targetId: string
  targetLabel: string
  status: SshConnectionStatus
  // The failure detail behind the status. Shown beneath the canned sentence rather than instead of
  // it, because the sentence says what to do and this says what happened — a host key rejection
  // names the remedy here and nowhere else in the terminal.
  error?: string | null
  // The SSH target was removed entirely — reconnect is impossible, so offer to
  // remove the workspace instead of a Connect button that can only fail.
  targetRemoved?: boolean
  // The user's own Disconnect holds the host down, so nothing reconnects it until they click.
  disconnectedByUser?: boolean
  worktreeId?: string
  // Set when the SSH target belongs to a remote Orca server (runtime
  // environment): Connect and the failed-connect resync then route to that
  // environment's runtime RPC and bucket instead of the local ssh.* API.
  sshOwnerEnvironmentId?: string | null
}

function messageForStatus(
  status: SshConnectionStatus,
  targetLabel: string,
  disconnectedByUser: boolean
): string {
  if (disconnectedByUser && status === 'disconnected') {
    return translate(
      'auto.components.terminal.pane.TerminalSshReconnectOverlay.disconnectedByUser',
      'You disconnected {{value0}}. Connect to continue this terminal session.',
      { value0: targetLabel }
    )
  }
  switch (status) {
    case 'auth-failed':
      return translate(
        'auto.components.terminal.pane.TerminalSshReconnectOverlay.authFailed',
        'Authentication failed for {{value0}}. Connect again to continue this terminal session.',
        { value0: targetLabel }
      )
    case 'error':
    case 'reconnection-failed':
      return translate(
        'auto.components.terminal.pane.TerminalSshReconnectOverlay.reconnectFailed',
        'The SSH connection to {{value0}} failed. Connect again to continue this terminal session.',
        { value0: targetLabel }
      )
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return translate(
        'auto.components.terminal.pane.TerminalSshReconnectOverlay.connecting',
        'Connecting to {{value0}}. This terminal will resume after the host is available.',
        { value0: targetLabel }
      )
    case 'connected':
      return translate(
        'auto.components.terminal.pane.TerminalSshReconnectOverlay.connected',
        'SSH is connected.'
      )
    case 'disconnected':
      return translate(
        'auto.components.terminal.pane.TerminalSshReconnectOverlay.disconnected',
        'This terminal is waiting for {{value0}}. Connect to continue this SSH session.',
        { value0: targetLabel }
      )
  }
}

export function TerminalSshReconnectOverlay({
  targetId,
  targetLabel,
  status,
  error = null,
  targetRemoved = false,
  disconnectedByUser = false,
  worktreeId,
  sshOwnerEnvironmentId = null
}: TerminalSshReconnectOverlayProps): React.JSX.Element {
  // Why: shared registry, not local state — the sidebar card control can dial the same
  // target, and the store status lags a click by one IPC hop.
  const connecting = useSshConnectInFlight(targetId)
  const isConnecting = connecting || isConnectingSshStatus(status)
  // Why: a removed target can never reconnect, so never offer Connect for it.
  const showConnect = !targetRemoved && canConnectSshStatus(status)
  const executionHostId = sshOwnerEnvironmentId
    ? toRuntimeExecutionHostId(sshOwnerEnvironmentId)
    : toSshExecutionHostId(targetId)

  const handleConnect = useCallback(
    () =>
      connectSshTargetForUser({
        targetId,
        status,
        environmentId: sshOwnerEnvironmentId,
        connectFailedMessage: translate(
          'auto.components.terminal.pane.TerminalSshReconnectOverlay.connectFailed',
          'SSH connection failed'
        )
      }),
    [sshOwnerEnvironmentId, status, targetId]
  )

  // Why: z-40 clears pane-local chrome (focus rim z-30); bg-card is fully opaque so terminal text cannot paint through.
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-40 flex justify-center"
      data-terminal-ssh-reconnect-banner={status}
      data-ssh-disconnected-by-user={disconnectedByUser ? 'true' : undefined}
    >
      <div
        className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-md border border-border bg-card px-3 py-3 text-card-foreground shadow-xs"
        role="status"
        aria-live="polite"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          {isConnecting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ServerOff className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="shrink-0 text-sm font-semibold">
              {targetRemoved
                ? translate(
                    'auto.components.terminal.pane.TerminalSshReconnectOverlay.removedTitle',
                    'SSH host removed'
                  )
                : translate(
                    'auto.components.terminal.pane.TerminalSshReconnectOverlay.title',
                    'SSH connection required'
                  )}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Server className="size-3.5 shrink-0" />
              <span className="truncate font-medium">{targetLabel}</span>
            </div>
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {targetRemoved
              ? translate(
                  'auto.components.terminal.pane.TerminalSshReconnectOverlay.removedBody',
                  'The SSH host for this workspace was removed, so it can no longer connect. Remove the workspace to clear it — remote files are left untouched.'
                )
              : messageForStatus(status, targetLabel, disconnectedByUser)}
          </div>
          {/* Why not truncated: a host key failure ends in `ssh-keygen -R <host>`, and a removed
              target already explains itself above. */}
          {!targetRemoved && error ? (
            <div className="mt-1 text-xs leading-5 text-red-400 [overflow-wrap:anywhere]">
              {error}
            </div>
          ) : null}
        </div>
        {targetRemoved ? (
          <Button
            className="shrink-0"
            size="sm"
            variant="outline"
            onClick={
              worktreeId
                ? () => runWorktreeDelete(worktreeId, { expectedHostId: executionHostId })
                : undefined
            }
            disabled={!worktreeId}
          >
            {translate(
              'auto.components.terminal.pane.TerminalSshReconnectOverlay.removeWorkspaceButton',
              'Remove workspace'
            )}
          </Button>
        ) : (
          <Button
            className="shrink-0"
            size="sm"
            onClick={showConnect ? () => void handleConnect() : undefined}
            disabled={!showConnect || isConnecting}
          >
            {!showConnect || isConnecting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {sshConnectingLabel()}
              </>
            ) : (
              sshConnectVerb(status)
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
