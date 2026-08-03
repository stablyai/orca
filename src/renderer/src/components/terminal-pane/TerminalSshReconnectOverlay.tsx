import { useCallback, useState } from 'react'
import { Loader2, Server, ServerOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import {
  connectRuntimeEnvironmentSshTarget,
  resyncRuntimeEnvironmentSshTargets
} from '@/runtime/runtime-environment-ssh-state'

type TerminalSshReconnectOverlayProps = {
  targetId: string
  targetLabel: string
  status: SshConnectionStatus
  // The SSH target was removed entirely — reconnect is impossible, so offer to
  // remove the workspace instead of a Connect button that can only fail.
  targetRemoved?: boolean
  worktreeId?: string
  // Set when the SSH target belongs to a remote Orca server (runtime
  // environment): Connect and the failed-connect resync then route to that
  // environment's runtime RPC and bucket instead of the local ssh.* API.
  sshOwnerEnvironmentId?: string | null
}

// Why: relay deployment/reconnect are host-driven transient states; the
// failure statuses need a user-initiated retry before the PTY can resume.
function isConnectingStatus(status: SshConnectionStatus): boolean {
  return status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting'
}

function canConnectStatus(status: SshConnectionStatus): boolean {
  return ['disconnected', 'reconnection-failed', 'error', 'auth-failed'].includes(status)
}

function messageForStatus(status: SshConnectionStatus, targetLabel: string): string {
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
  targetRemoved = false,
  worktreeId,
  sshOwnerEnvironmentId = null
}: TerminalSshReconnectOverlayProps): React.JSX.Element {
  const [connecting, setConnecting] = useState(false)
  const mountedRef = useMountedRef()
  const setSshConnectionState = useAppStore((store) => store.setSshConnectionState)
  const isConnecting = connecting || isConnectingStatus(status)
  // Why: a removed target can never reconnect, so never offer Connect for it.
  const showConnect = !targetRemoved && canConnectStatus(status)

  const handleConnect = useCallback(async () => {
    if (isConnecting) {
      return
    }
    setConnecting(true)
    try {
      if (sshOwnerEnvironmentId) {
        // Bucket state is written inside the helper, mirroring the local path.
        await connectRuntimeEnvironmentSshTarget(sshOwnerEnvironmentId, targetId)
      } else {
        const connectState = await window.api.ssh.connect({ targetId })
        if (connectState) {
          // Why: ssh.connect can resolve before the global state-change IPC lands;
          // the waiting deferred PTY reattach path keys off this renderer store.
          setSshConnectionState(targetId, connectState)
        }
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.terminal.pane.TerminalSshReconnectOverlay.connectFailed',
              'SSH connection failed'
            )
      )
      // Why: a failed connect usually means the renderer's target metadata is
      // stale (target removed, or re-added under a new id). Resync it so the
      // overlay converges to the ghost/re-adopted state instead of offering
      // the same failing Connect forever (STA-1468). Apply the target list
      // first — a removed-labels failure must not discard it.
      if (sshOwnerEnvironmentId) {
        void resyncRuntimeEnvironmentSshTargets(sshOwnerEnvironmentId).catch(() => {})
      } else {
        void (async () => {
          const targets = await window.api.ssh.listTargets()
          useAppStore.getState().setSshTargetsMetadata(targets)
          const removedLabels = await window.api.ssh.listRemovedTargetLabels()
          useAppStore.getState().setRemovedSshTargetLabels(removedLabels)
        })().catch(() => {})
      }
    } finally {
      if (mountedRef.current) {
        setConnecting(false)
      }
    }
  }, [isConnecting, mountedRef, setSshConnectionState, sshOwnerEnvironmentId, targetId])

  // Why: z-40 clears pane-local chrome (focus rim z-30); bg-card is fully opaque so terminal text cannot paint through.
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-40 flex justify-center"
      data-terminal-ssh-reconnect-banner={status}
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
              : messageForStatus(status, targetLabel)}
          </div>
        </div>
        {targetRemoved ? (
          <Button
            className="shrink-0"
            size="sm"
            variant="outline"
            onClick={worktreeId ? () => runWorktreeDelete(worktreeId) : undefined}
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
                {translate(
                  'auto.components.terminal.pane.TerminalSshReconnectOverlay.connectingButton',
                  'Connecting...'
                )}
              </>
            ) : (
              translate(
                'auto.components.terminal.pane.TerminalSshReconnectOverlay.connectButton',
                'Connect'
              )
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
