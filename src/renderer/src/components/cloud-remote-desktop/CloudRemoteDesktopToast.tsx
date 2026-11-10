import type React from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudRemoteDesktopFailureCode } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'

export type CloudRemoteDesktopNextAction =
  | 'wake'
  | 'unarchive'
  | 'sign_in'
  | 'create_workspace'
  | 'retry'

/** What main reports, plus the renderer's own: a Wake from this toast that didn't wake it. */
export type CloudRemoteDesktopToastFailure = CloudRemoteDesktopFailureCode | 'wake_failed'

export type CloudRemoteDesktopToastState =
  | { kind: 'starting'; slow: boolean }
  /** Wake (or Unarchive) from this toast: the desktop opens by itself once the sandbox is awake. */
  | { kind: 'waking'; via: 'wake' | 'unarchive' }
  | { kind: 'failed'; code: CloudRemoteDesktopToastFailure }

type FailureCopy = {
  title: string
  detail: string
  action: CloudRemoteDesktopNextAction | null
  /** Overrides the action's usual label (a failed wake retries the wake: "Try again"). */
  actionLabel?: string
  /** Asleep and starting are states, not errors. */
  tone?: 'neutral'
}

function failureCopy(t: Translate, code: CloudRemoteDesktopToastFailure): FailureCopy {
  switch (code) {
    case 'not_cloud':
      return {
        title: t(
          'components.cloudRemoteDesktop.notCloudTitle',
          'Remote desktop is only available in cloud workspaces.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.notCloudDetail',
          'Create a cloud workspace to run apps with a screen.'
        ),
        action: 'create_workspace'
      }
    case 'not_running':
      return {
        title: t('components.cloudRemoteDesktop.asleepTitle', 'This sandbox is asleep.'),
        detail: t(
          'components.cloudRemoteDesktop.asleepDetail',
          'Wake it to open the remote desktop. Your files are safe.'
        ),
        action: 'wake',
        tone: 'neutral'
      }
    case 'wake_failed':
      return {
        title: t('components.cloudRemoteDesktop.wakeFailedTitle', 'Couldn’t wake the sandbox.'),
        detail: t('components.cloudRemoteDesktop.wakeFailedDetail', 'Your files are safe.'),
        action: 'wake',
        actionLabel: t('components.cloudRemoteDesktop.retry', 'Try again')
      }
    case 'archived':
      return {
        title: t('components.cloudRemoteDesktop.archivedTitle', 'This workspace is archived.'),
        detail: t(
          'components.cloudRemoteDesktop.archivedDetail',
          'Unarchive it to open the remote desktop. Your files are safe.'
        ),
        action: 'unarchive',
        tone: 'neutral'
      }
    case 'starting':
      return {
        title: t(
          'components.cloudRemoteDesktop.startingTitle',
          'The sandbox is still starting or waking.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.startingDetail',
          'Try again in a moment. Your files are safe.'
        ),
        action: 'retry',
        tone: 'neutral'
      }
    case 'not_installed':
      return {
        title: t(
          'components.cloudRemoteDesktop.notInstalledTitle',
          'This sandbox doesn’t have a remote desktop yet.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.notInstalledDetail',
          'It was created before remote desktop was available. New cloud workspaces include it. Your files are safe.'
        ),
        action: 'create_workspace'
      }
    case 'signed_out':
      return {
        title: t(
          'components.cloudRemoteDesktop.signedOutTitle',
          'You’re signed out of Orca Cloud.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.signedOutDetail',
          'Sign in, then open the remote desktop again.'
        ),
        action: 'sign_in'
      }
    case 'forward_failed':
      return {
        title: t(
          'components.cloudRemoteDesktop.forwardFailedTitle',
          'Couldn’t connect this computer to the remote desktop.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.forwardFailedDetail',
          'The desktop is running in the sandbox. Your files are safe.'
        ),
        action: 'retry'
      }
    case 'unavailable':
      return {
        title: t(
          'components.cloudRemoteDesktop.unavailableTitle',
          'Couldn’t start the remote desktop.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.unavailableDetail',
          'Orca Cloud didn’t respond in time. Your files are safe.'
        ),
        action: 'retry'
      }
  }
}

function actionLabel(t: Translate, action: CloudRemoteDesktopNextAction): string {
  switch (action) {
    case 'wake':
      return t('components.cloudRemoteDesktop.wake', 'Wake sandbox')
    case 'unarchive':
      return t('components.cloudRemoteDesktop.unarchive', 'Unarchive')
    case 'sign_in':
      return t('components.cloudRemoteDesktop.signIn', 'Sign in')
    case 'create_workspace':
      return t('components.cloudRemoteDesktop.createWorkspace', 'Create workspace')
    case 'retry':
      return t('components.cloudRemoteDesktop.retry', 'Try again')
  }
}

/** Toast body for "Open remote desktop": a neutral starting notice, or one error with one next action. */
export function CloudRemoteDesktopToast({
  state,
  onAction,
  onDismiss
}: {
  state: CloudRemoteDesktopToastState
  onAction: (action: CloudRemoteDesktopNextAction) => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const dismissButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t('components.cloudRemoteDesktop.dismiss', 'Dismiss')}
      className="absolute top-1.5 right-1.5"
      onClick={onDismiss}
    >
      <X aria-hidden />
    </Button>
  )
  if (state.kind === 'starting' || state.kind === 'waking') {
    const slow = state.kind === 'starting' && state.slow
    return (
      <div className="relative flex w-[356px] items-center gap-3 rounded-lg border border-border bg-popover py-2.5 pr-9 pl-3 text-sm text-popover-foreground shadow-lg">
        <Loader2
          className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
          aria-hidden
        />
        <div role="status" className="min-w-0 space-y-0.5">
          <p className="font-medium">
            {state.kind === 'waking'
              ? state.via === 'unarchive'
                ? t('components.cloudRemoteDesktop.unarchiving', 'Unarchiving workspace…')
                : t('components.cloudRemoteDesktop.waking', 'Waking sandbox…')
              : slow
                ? t('components.cloudRemoteDesktop.stillStarting', 'Still starting…')
                : t('components.cloudRemoteDesktop.starting', 'Starting remote desktop…')}
          </p>
          {state.kind === 'waking' ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'components.cloudRemoteDesktop.wakingDetail',
                'The remote desktop opens when it’s awake.'
              )}
            </p>
          ) : slow ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'components.cloudRemoteDesktop.slowDetail',
                'The first start in a sandbox can take up to a minute.'
              )}
            </p>
          ) : null}
        </div>
        {/* Hides the notice only: the desktop still opens when it's ready. */}
        {dismissButton}
      </div>
    )
  }
  const copy = failureCopy(t, state.code)
  return (
    // The action sits under the text inside the error box: a 356px toast has no room beside it.
    <div className="relative w-[356px] rounded-lg bg-popover shadow-lg">
      <InlineError
        title={copy.title}
        detail={copy.detail}
        tone={copy.tone}
        layout="toast"
        action={
          copy.action ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onAction(copy.action!)}
            >
              {copy.actionLabel ?? actionLabel(t, copy.action)}
            </Button>
          ) : undefined
        }
      />
      {dismissButton}
    </div>
  )
}
