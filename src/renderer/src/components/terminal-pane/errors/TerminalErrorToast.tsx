import {
  isSshReconnectOwnedTerminalError,
  shouldOfferDaemonRestart,
  isExplainedTerminalError,
  isRemoteTerminalClosedError,
  isReattachRetryError,
  isFolderWorkspacePathOnlyError,
  humanizeTerminalError
} from './terminal-error-display'
import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { isAgentLaunchOnlyError } from '../launch-outcome/agent-launch-pane-notice-text'
import { hasClientEnvironmentFooter } from '../../../../../shared/client-environment-info'
import {
  failedSpawnEnvironmentFooter,
  withoutTerminalSpawnIssueRequest
} from './terminal-spawn-error-display'
import { isWslDistroHoldText } from '@/runtime/hosts/wsl/wsl-distro-hold-copy'
import { isSshSignInRequiredTerminalError } from './terminal-ssh-sign-in-error'

export function TerminalErrorToast({
  error,
  agentId,
  paneOnClient = true,
  onDismiss,
  onRestartDaemon,
  onRetry,
  onRestoreTerminalFocus,
  onOpenNewTerminal,
  onClosePane
}: {
  error: string
  agentId?: string | null
  /** False for a pane on an SSH or remote host, or one whose host is not yet known. */
  paneOnClient?: boolean
  onDismiss: () => void
  onRestartDaemon?: () => void
  onRetry?: () => Promise<boolean>
  onRestoreTerminalFocus?: () => void
  /** Leaves this pane and its saved session untouched. */
  onOpenNewTerminal?: () => void
  /** Dismissing only hides the toast; the dead pane needs a way out from where the user is looking (#21342). */
  onClosePane?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // An SSH host state (reconnecting, or waiting for the user to sign in), not a bug to report.
  const ssh = isSshSignInRequiredTerminalError(error) || isSshReconnectOwnedTerminalError(error)
  // Why: the client's OS and shell describe neither the host nor its shell, and the renderer knows neither.
  const showClientEnvironment = paneOnClient && !ssh
  const paneOwnerUnverified = isReattachRetryError(error)
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
  const humanizedError = humanizeTerminalError(error, agentId, t)
  // Why: the toast appends its own linked request, so the host's plain-text one would repeat it.
  const displayError = showIssueLink
    ? withoutTerminalSpawnIssueRequest(humanizedError)
    : humanizedError
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
    onRestoreTerminalFocus?.()
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
      role="alert"
      className={`scrollbar-sleek pointer-events-auto absolute inset-x-3 bottom-[min(0.75rem,10%)] z-50 flex max-h-[calc(100%-min(1.5rem,20%))] flex-col overflow-y-auto rounded-xl border bg-card text-card-foreground shadow-floating outline-none focus-visible:ring-2 focus-visible:ring-ring ${paneOwnerUnverified || ssh ? 'border-border' : 'border-destructive/50'}`}
    >
      <div className="flex shrink-0 items-start gap-3 p-4">
        <span
          className={
            paneOwnerUnverified || ssh
              ? 'flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground'
              : 'flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive'
          }
        >
          <AlertTriangle className="size-4" />
        </span>
        <div className="min-w-0 flex-1 pt-1">
          <div className="text-sm font-semibold leading-5">
            {paneOwnerUnverified || ssh
              ? t('auto.components.terminal.pane.TerminalErrorToast.title', 'Terminal issue')
              : t('auto.components.terminal.pane.TerminalErrorToast.errorTitle', 'Terminal error')}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={t('terminal.paneTopBanner.dismiss', 'Dismiss')}
        >
          <X />
        </Button>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="whitespace-pre-wrap break-words text-sm leading-5">{displayError}</div>
        {showDaemonRestart ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t(
              'auto.components.terminal.pane.TerminalErrorToast.cc6d997c65',
              'Restart the terminal daemon from here to clear stale daemon state.'
            )}
          </p>
        ) : showIssueLink ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t(
              'auto.components.terminal.pane.TerminalErrorToast.5c8ce20be6',
              'If this persists, please'
            )}{' '}
            <a
              href="https://github.com/stablyai/orca/issues"
              className="underline underline-offset-2"
            >
              {t('auto.components.terminal.pane.TerminalErrorToast.a7e2fd2699', 'file an issue')}
            </a>
            .
          </p>
        ) : null}
        {showClientEnvironment && footer ? (
          <div className="mt-3 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {footer}
          </div>
        ) : null}
        {paneOwnerUnverified && retryFailed ? (
          <p className="mt-3 text-xs text-destructive">
            {t(
              'auto.components.terminal.pane.TerminalErrorToast.retryUnavailable',
              'Retry could not reconnect yet. Try again shortly.'
            )}
          </p>
        ) : null}
        {showDaemonRestart ||
        (paneOwnerUnverified && (onRetry || onOpenNewTerminal)) ||
        (onClosePane && isRemoteTerminalClosedError(error)) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {showDaemonRestart ? (
              <Button size="sm" onClick={onRestartDaemon}>
                {t('auto.components.terminal.pane.TerminalErrorToast.e4aa243f8c', 'Restart daemon')}
              </Button>
            ) : null}
            {paneOwnerUnverified && onRetry ? (
              <Button size="sm" onClick={() => void handleRetry()} disabled={retrying}>
                {retrying
                  ? t('auto.components.terminal.pane.TerminalErrorToast.retrying', 'Retrying…')
                  : t('auto.components.terminal.pane.TerminalErrorToast.retry', 'Retry')}
              </Button>
            ) : null}
            {paneOwnerUnverified && onOpenNewTerminal ? (
              <Button
                variant={onRetry ? 'secondary' : 'default'}
                size="sm"
                onClick={onOpenNewTerminal}
              >
                {t(
                  'auto.components.terminal.pane.TerminalErrorToast.openNewTerminal',
                  'Open new terminal'
                )}
              </Button>
            ) : null}
            {onClosePane && isRemoteTerminalClosedError(error) ? (
              <Button variant="outline" size="sm" onClick={onClosePane}>
                {t('auto.components.terminal.pane.TerminalContextMenu.8c17d6786d', 'Close Pane')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
