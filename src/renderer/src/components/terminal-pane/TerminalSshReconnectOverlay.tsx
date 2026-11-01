import { useCallback } from 'react'
import { Loader2, Server, ServerOff } from 'lucide-react'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
import { Button } from '@/components/ui/button'
import { SshHostNodeMirrorAction } from '@/components/settings/SshHostNodeMirrorAction'
import { SshHostMoveAnywayButton } from '@/components/settings/SshHostMoveAnywayAction'
import { OpenPlainSshTerminalButton } from '@/components/plain-ssh-terminal/OpenPlainSshTerminalButton'
import { useAppStore } from '@/store'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import {
  connectRuntimeEnvironmentSshTarget,
  resyncRuntimeEnvironmentSshTargets
} from '@/runtime/runtime-environment-ssh-state'
import { canConnectSshStatus, isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { sshConnectingLabel, sshConnectVerb } from '@/ssh/ssh-connect-verb'
import { SSH_RECONNECT_UI_TIMEOUT_MS, withUiConnectTimeout } from '@/ssh/ssh-connect-ui-timeout'
import {
  isSshConnectInFlight,
  trackSshConnect,
  useSshConnectInFlight
} from '@/ssh/ssh-connect-in-flight'

type TerminalSshReconnectOverlayProps = {
  targetId: string
  targetLabel: string
  status: SshConnectionStatus
  // Keep failure detail beneath the action sentence because it can carry the terminal’s only host-key remedy.
  error?: string | null
  // Removed targets cannot reconnect; offer workspace removal instead.
  targetRemoved?: boolean
  worktreeId?: string
  // Route server-owned targets and failed-connect resync through that environment’s RPC/state bucket.
  sshOwnerEnvironmentId?: string | null
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
  error = null,
  targetRemoved = false,
  worktreeId,
  sshOwnerEnvironmentId = null
}: TerminalSshReconnectOverlayProps): React.JSX.Element {
  const setSshConnectionState = useAppStore((store) => store.setSshConnectionState)
  const managedServer = useAppStore(
    (store) => store.sshConnectionStates.get(targetId)?.managedServer
  )
  // Share in-flight state with sidebar controls because store status trails clicks by one IPC hop.
  const connecting = useSshConnectInFlight(targetId)
  const isConnecting = connecting || isConnectingSshStatus(status)
  const showConnect = !targetRemoved && canConnectSshStatus(status)
  const executionHostId = sshOwnerEnvironmentId
    ? toRuntimeExecutionHostId(sshOwnerEnvironmentId)
    : toSshExecutionHostId(targetId)

  const handleConnect = useCallback(async () => {
    if (isSshConnectInFlight(targetId) || isConnectingSshStatus(status)) {
      return
    }
    try {
      if (sshOwnerEnvironmentId) {
        await trackSshConnect(
          targetId,
          connectRuntimeEnvironmentSshTarget(sshOwnerEnvironmentId, targetId)
        )
      } else {
        // Track the backend request beyond UI timeout or another click could open a duplicate credential prompt.
        const connectState = await withUiConnectTimeout(
          trackSshConnect(targetId, window.api.ssh.connect({ targetId })),
          SSH_RECONNECT_UI_TIMEOUT_MS
        )
        if (connectState) {
          // Publish before delayed global IPC so waiting deferred PTYs can reattach.
          setSshConnectionState(targetId, connectState)
        }
      }
    } catch (err) {
      toastSshConnectFailure(
        targetId,
        err,
        translate(
          'auto.components.terminal.pane.TerminalSshReconnectOverlay.connectFailed',
          'SSH connection failed'
        ),
        sshOwnerEnvironmentId
      )
      // Resync stale target metadata after failed connect; apply targets before optional removed-label metadata so removal can still converge.
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
    }
  }, [setSshConnectionState, sshOwnerEnvironmentId, status, targetId])

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
          {/* Keep the full host-key remedy visible; removed targets already have their own explanation. */}
          {!targetRemoved && error ? (
            <div className="mt-1 text-xs leading-5 text-red-400 [overflow-wrap:anywhere]">
              {error}
            </div>
          ) : null}
          {!targetRemoved ? (
            <div className="mt-2 flex flex-wrap gap-2 empty:hidden">
              <SshHostNodeMirrorAction
                targetId={targetId}
                status={managedServer}
                ownerEnvironmentId={sshOwnerEnvironmentId}
              />
              {/* Why local only: the dialog drives this desktop's own move, not a server's. */}
              {sshOwnerEnvironmentId ? null : (
                <SshHostMoveAnywayButton
                  target={{ id: targetId, label: targetLabel }}
                  status={managedServer}
                  // A connect in flight may clear the refusal; a click would start a second one.
                  disabled={isConnecting}
                />
              )}
              <OpenPlainSshTerminalButton
                targetId={targetId}
                targetLabel={targetLabel}
                status={managedServer}
                ownerEnvironmentId={sshOwnerEnvironmentId}
              />
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
