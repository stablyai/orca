import {
  isSshReconnectOwnedTerminalError,
  shouldOfferDaemonRestart,
  isExplainedTerminalError,
  isRemoteTerminalClosedError,
  isPaneOwnerRecoveryError,
  isFolderWorkspacePathOnlyError,
  humanizeTerminalError
} from './terminal-error-display'
import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { isAgentLaunchOnlyError } from '../launch-outcome/agent-launch-pane-notice-text'
import { hasClientEnvironmentFooter } from '../../../../../shared/client-environment-info'
import {
  failedSpawnEnvironmentFooter,
  withoutTerminalSpawnIssueRequest
} from './terminal-spawn-error-display'
import { isWslDistroHoldText } from '@/lib/wsl-distro-hold-copy'
import { isSshSignInRequiredTerminalError } from './terminal-ssh-sign-in-error'

export function TerminalErrorToast({
  error,
  resourceLimit = false,
  agentId,
  paneOnClient = true,
  onDismiss,
  onRestartDaemon,
  onRetry,
  onOpenNewTerminal,
  onClosePane
}: {
  error: string
  /** Classified from separate source events before their display text is joined. */
  resourceLimit?: boolean
  agentId?: string | null
  /** False for a pane on an SSH or remote host, or one whose host is not yet known. */
  paneOnClient?: boolean
  onDismiss: () => void
  onRestartDaemon?: () => void
  onRetry?: () => Promise<boolean>
  /** Leaves this pane and its saved session untouched. */
  onOpenNewTerminal?: () => void
  /** Dismissing only hides the toast; the dead pane needs a way out from where the user is looking (#21342). */
  onClosePane?: () => void
}): React.JSX.Element {
  // An SSH host state (reconnecting, or waiting for the user to sign in), not a bug to report.
  const ssh = isSshSignInRequiredTerminalError(error) || isSshReconnectOwnedTerminalError(error)
  // Why: the client's OS and shell describe neither the host nor its shell, and the renderer knows neither.
  const showClientEnvironment = paneOnClient && !ssh
  const paneOwnerUnverified = isPaneOwnerRecoveryError(error)
  const showDaemonRestart = !ssh && onRestartDaemon && shouldOfferDaemonRestart(error)
  // Restart cannot recover a session after its owning daemon exits.
  const showIssueLink =
    !ssh &&
    !paneOwnerUnverified &&
    !showDaemonRestart &&
    !isAgentLaunchOnlyError(error) &&
    !isExplainedTerminalError(error) &&
    !isFolderWorkspacePathOnlyError(error) &&
    !isWslDistroHoldText(error)
  const humanizedError = humanizeTerminalError(error, agentId)
  // Why: the toast appends its own linked request, so the host's plain-text one would repeat it.
  const displayError = showIssueLink
    ? withoutTerminalSpawnIssueRequest(humanizedError)
    : humanizedError
  const tint =
    paneOwnerUnverified || resourceLimit
      ? null
      : ssh
        ? 'color-mix(in srgb, var(--color-amber-500) 20%, var(--popover))'
        : 'color-mix(in srgb, var(--destructive) 20%, var(--popover))'
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  const [environmentFooter, setEnvironmentFooter] = useState<{
    error: string
    footer: string
  } | null>(null)

  // Why: a select-all copy should carry details loaded asynchronously from preload.
  useEffect(() => {
    if (!showClientEnvironment || hasClientEnvironmentFooter(displayError)) {
      return
    }
    let cancelled = false
    void failedSpawnEnvironmentFooter(displayError).then((footer) => {
      if (!cancelled) {
        setEnvironmentFooter({ error: displayError, footer })
      }
    })
    return () => {
      cancelled = true
    }
  }, [displayError, showClientEnvironment])

  const footer = environmentFooter?.error === displayError ? environmentFooter.footer : ''
  const handleRetry = async (): Promise<void> => {
    if (!onRetry || retrying) {
      return
    }
    setRetrying(true)
    setRetryFailed(false)
    try {
      setRetryFailed(!(await onRetry()))
    } catch {
      // Keep the safety warning available when a best-effort remount cannot start.
      setRetryFailed(true)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      data-terminal-error-toast
      data-terminal-error-kind={paneOwnerUnverified ? 'owner-unverified' : ssh ? 'ssh' : 'error'}
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        right: 12,
        zIndex: 50,
        padding: '10px 14px',
        borderRadius: 6,
        background: 'var(--popover)',
        backgroundImage: tint ? `linear-gradient(${tint}, ${tint})` : undefined,
        border: paneOwnerUnverified
          ? '1px solid var(--color-amber-500)'
          : ssh
            ? '1px solid rgba(234, 179, 8, 0.35)'
            : resourceLimit
              ? '1px solid var(--border)'
              : '1px solid rgba(220, 38, 38, 0.4)',
        color: 'var(--popover-foreground)',
        fontSize: 12,
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <span style={{ minWidth: 0 }}>
          {displayError}
          {showDaemonRestart ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.cc6d997c65',
                'Restart the terminal daemon from here to clear stale daemon state.'
              )}
            </>
          ) : showIssueLink ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.5c8ce20be6',
                'If this persists, please'
              )}{' '}
              <a
                href="https://github.com/stablyai/orca/issues"
                style={{ color: 'inherit', textDecoration: 'underline' }}
              >
                {translate(
                  'auto.components.terminal.pane.TerminalErrorToast.a7e2fd2699',
                  'file an issue'
                )}
              </a>
              .
            </>
          ) : null}
          {showClientEnvironment && footer ? `\n\n${footer}` : null}
          {paneOwnerUnverified && retryFailed
            ? `\n${translate(
                'auto.components.terminal.pane.TerminalErrorToast.retryUnavailable',
                'Retry could not reconnect yet. Try again shortly.'
              )}`
            : null}
        </span>
        {showDaemonRestart ? (
          <button
            onClick={onRestartDaemon}
            style={{
              marginLeft: 12,
              border: '1px solid rgba(252, 165, 165, 0.45)',
              borderRadius: 6,
              background: 'rgba(127, 29, 29, 0.35)',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalErrorToast.e4aa243f8c',
              'Restart daemon'
            )}
          </button>
        ) : null}
        {paneOwnerUnverified && onRetry ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void handleRetry()}
            disabled={retrying}
            className="ml-3 border-amber-500/50 bg-popover text-popover-foreground hover:bg-amber-500/20"
          >
            {retrying
              ? translate('auto.components.terminal.pane.TerminalErrorToast.retrying', 'Retrying…')
              : translate('auto.components.terminal.pane.TerminalErrorToast.retry', 'Retry')}
          </Button>
        ) : null}
        {/* Why: an owner can stay unverifiable, so Retry alone can loop forever. */}
        {paneOwnerUnverified && onOpenNewTerminal ? (
          <Button variant="outline" size="xs" onClick={onOpenNewTerminal} className="ml-2">
            {translate(
              'auto.components.terminal.pane.TerminalErrorToast.openNewTerminal',
              'Open new terminal'
            )}
          </Button>
        ) : null}
        {onClosePane && isRemoteTerminalClosedError(error) ? (
          <Button variant="outline" size="xs" onClick={onClosePane} className="ml-3">
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
              'Close Pane'
            )}
          </Button>
        ) : null}
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 0 0 8px',
            lineHeight: 1,
            flexShrink: 0
          }}
        >
          ×
        </button>
      </div>
    </div>
  )
}
