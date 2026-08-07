import { useCallback, useRef } from 'react'
import { Copy, Loader2, Server, ServerOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { assertClipboardTextWriteWithinLimit } from '../../../../shared/clipboard-text'
import { translate } from '@/i18n/i18n'
import { buildSshDiagnosticReport, formatSshDiagnosticReport } from '@/lib/ssh-diagnostic-report'
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
  // The SSH target was removed entirely — reconnect is impossible, so offer to
  // remove the workspace instead of a Connect button that can only fail.
  targetRemoved?: boolean
  worktreeId?: string
  // Set when the SSH target belongs to a remote Orca server (runtime
  // environment): Connect and the failed-connect resync then route to that
  // environment's runtime RPC and bucket instead of the local ssh.* API.
  sshOwnerEnvironmentId?: string | null
}

// Why: the web stub cannot reach the serving host's consent, so it reports
// diagnostics off for every browser client — name that instead of blaming a
// setting the user never touched.
function isWebClient(): boolean {
  return (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
}

// Why: report assembly is synchronous precisely because a wedged main process is
// the state it exists for. EVERY round-trip in front of it must be bounded — the
// consent read and the clipboard write alike. Bounding only the first left the
// second able to hang forever, which is the inert-button-with-no-toast failure
// this timeout exists to remove.
const DIAGNOSTICS_CONSENT_TIMEOUT_MS = 3_000
const CLIPBOARD_WRITE_TIMEOUT_MS = 3_000

// Rejects rather than resolving a default: a stalled main process belongs in the
// copy-failed toast, not in a branch that blames a setting the user never touched.
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out ${label}`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer)
  })
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
  const mountedRef = useMountedRef()
  const copyInFlightRef = useRef(false)
  const setSshConnectionState = useAppStore((store) => store.setSshConnectionState)
  // Why: shared registry, not local state — the sidebar card control can dial the same
  // target, and the store status lags a click by one IPC hop.
  const connecting = useSshConnectInFlight(targetId)
  const isConnecting = connecting || isConnectingSshStatus(status)
  // Why: a removed target can never reconnect, so never offer Connect for it.
  const showConnect = !targetRemoved && canConnectSshStatus(status)

  const handleConnect = useCallback(async () => {
    if (isSshConnectInFlight(targetId) || isConnectingSshStatus(status)) {
      return
    }
    try {
      if (sshOwnerEnvironmentId) {
        // Bucket state is written inside the helper, mirroring the local path.
        await trackSshConnect(
          targetId,
          connectRuntimeEnvironmentSshTarget(sshOwnerEnvironmentId, targetId)
        )
      } else {
        // Why: track the connect request, not this bounded wait — the backend is still
        // dialing after the UI timeout fires, so releasing here would let the next click
        // raise a second credential prompt.
        const connectState = await withUiConnectTimeout(
          trackSshConnect(targetId, window.api.ssh.connect({ targetId })),
          SSH_RECONNECT_UI_TIMEOUT_MS
        )
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
    }
  }, [setSshConnectionState, sshOwnerEnvironmentId, status, targetId])

  const handleCopyDiagnostics = useCallback(async () => {
    // Why a guard and not a disabled button: a wedged main process is the state
    // this exists for, so impatient repeat clicks are expected — each one used to
    // arm its own pair of round-trips and stack a toast per click.
    if (copyInFlightRef.current) {
      return
    }
    copyInFlightRef.current = true
    try {
      // Why: consent gates the copy, not the button — resolving it before the
      // click would pop the button in after first paint and resize the row (§7).
      const diagnosticsStatus = await withTimeout(
        window.api.diagnostics.getStatus(),
        DIAGNOSTICS_CONSENT_TIMEOUT_MS,
        'reading diagnostics consent'
      )
      // Why the flag and not one reason string: `ci` is resolved first and masks
      // an explicit ORCA_DIAGNOSTICS_DISABLED, and the web stub omits the reason
      // entirely. `localFileEnabled` is what every other diagnostics-egress
      // surface gates on, and it stays true under DO_NOT_TRACK — a network
      // signal that does not govern a clipboard copy.
      if (!diagnosticsStatus?.localFileEnabled) {
        if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.terminal.pane.TerminalSshReconnectOverlay.diagnosticsDisabled',
              'Diagnostics are disabled on this device.'
            )
          )
        }
        return
      }
      // Why not navigator.clipboard: it fails silently inside Radix surfaces.
      // Why assert rather than shed entries: the 512-char capture cap bounds the
      // report at ~2% of the clipboard limit, so a throw here means a new
      // unbounded field — surfacing it beats pasting a silently trimmed report.
      // Bounded like the consent read: the clipboard lives in main, so a wedged
      // main hangs this call, and an unbounded hang here is a button that never
      // answers. It still cannot SUCCEED against a dead main — nothing can — but
      // it fails loudly instead of silently.
      await withTimeout(
        window.api.ui.writeClipboardText(
          assertClipboardTextWriteWithinLimit(
            formatSshDiagnosticReport(
              buildSshDiagnosticReport({
                targetId,
                targetRemoved,
                environmentId: sshOwnerEnvironmentId ?? null
              })
            )
          )
        ),
        CLIPBOARD_WRITE_TIMEOUT_MS,
        'writing to the clipboard'
      )
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.terminal.pane.TerminalSshReconnectOverlay.diagnosticsCopied',
            'Diagnostics copied'
          )
        )
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.terminal.pane.TerminalSshReconnectOverlay.diagnosticsCopyFailed',
            'Failed to copy diagnostics'
          )
        )
      }
    } finally {
      copyInFlightRef.current = false
    }
  }, [copyInFlightRef, mountedRef, sshOwnerEnvironmentId, targetId, targetRemoved])

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
          {/* Why overflow-hidden: the title is shrink-0 so the host label truncates first, but below ~415px even the title overflows — clip it here or its bold glyphs paint over the copy button. */}
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
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
        {/* Recessive and mounted in every state: this overlay paints on every wake-from-sleep, so an eye-catching button would read as an alarm (§6.1). Hidden on web, where the stub reports consent off for every client, so the control could only ever produce its own failure toast. */}
        {isWebClient() ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                variant="ghost"
                size="icon-sm"
                onClick={() => void handleCopyDiagnostics()}
                aria-label={translate(
                  'auto.components.terminal.pane.TerminalSshReconnectOverlay.copyDiagnosticsLabel',
                  'Copy diagnostics'
                )}
              >
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'auto.components.terminal.pane.TerminalSshReconnectOverlay.copyDiagnosticsLabel',
                'Copy diagnostics'
              )}
            </TooltipContent>
          </Tooltip>
        )}
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
