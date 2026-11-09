import type React from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudRemoteDesktopFailureCode } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'

export type CloudRemoteDesktopNextAction = 'wake' | 'sign_in' | 'create_workspace' | 'retry'

export type CloudRemoteDesktopToastState =
  | { kind: 'starting'; slow: boolean }
  | { kind: 'failed'; code: CloudRemoteDesktopFailureCode }

type FailureCopy = { title: string; detail: string; action: CloudRemoteDesktopNextAction | null }

function failureCopy(t: Translate, code: CloudRemoteDesktopFailureCode): FailureCopy {
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
        title: t('components.cloudRemoteDesktop.asleepTitle', 'This workspace is asleep.'),
        detail: t(
          'components.cloudRemoteDesktop.asleepDetail',
          'Wake it, then open the remote desktop again. Your files are safe.'
        ),
        action: 'wake'
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
      return t('components.cloudRemoteDesktop.wake', 'Wake workspace')
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
  if (state.kind === 'starting') {
    return (
      <div
        role="status"
        className="flex w-[356px] items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg"
      >
        <Loader2
          className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
          aria-hidden
        />
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium">
            {state.slow
              ? t('components.cloudRemoteDesktop.stillStarting', 'Still starting…')
              : t('components.cloudRemoteDesktop.starting', 'Starting remote desktop…')}
          </p>
          {state.slow ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'components.cloudRemoteDesktop.slowDetail',
                'The first start in a sandbox can take up to a minute.'
              )}
            </p>
          ) : null}
        </div>
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
        layout="toast"
        action={
          copy.action ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onAction(copy.action!)}
            >
              {actionLabel(t, copy.action)}
            </Button>
          ) : undefined
        }
      />
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
    </div>
  )
}
