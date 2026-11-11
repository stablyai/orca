import { useEffect } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { registerSignInNotice } from '@/lib/orca-cloud/sign-in-notice-visibility'
import { Button } from './ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { useAppStore } from '../store'

async function copySignInLink(link: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(link)
    toast.success(translate('auto.components.OrcaSignInProgress.copied', 'Sign-in link copied'))
  } catch (error) {
    console.warn('Could not copy the Orca sign-in link:', error)
    toast.error(
      translate('auto.components.OrcaSignInProgress.copyFailed', 'Could not copy the link.')
    )
  }
}

/**
 * Never disabled by a pending sign-in, so a closed or lost tab can't strand the user. While the
 * browser is out it reads "Reopen browser" and reopens the same sign-in link; otherwise a click
 * starts a sign-in, replacing any pending one (main cancels it).
 */
export function OrcaSignInButton({
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'onClick' | 'type'>): React.JSX.Element {
  const t = useTranslate()
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const link = useAppStore((state) => state.orcaProfileSignInProgress?.link ?? null)
  const onClick = (): void => {
    if (!link) {
      void connect()
      return
    }
    void window.api.shell.openUrl(link).catch(() => void connect())
  }
  return (
    <Button {...props} type="button" onClick={onClick}>
      {link ? (
        <>
          {t('auto.components.OrcaSignInProgress.reopenBrowser', 'Reopen browser')}
          <ExternalLink aria-hidden />
        </>
      ) : (
        children
      )}
    </Button>
  )
}

function cancelSignIn(): void {
  void window.api.orcaProfiles.cancelSignIn().catch(() => {})
}

export function OrcaSignInWaitNotice({
  className
}: {
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const progress = useAppStore((state) => state.orcaProfileSignInProgress)
  const timedOut = useAppStore((state) => state.orcaProfileSignInEnd === 'timed-out')
  const signedIn = useAppStore((state) => state.orcaProfileAuthStatus?.state === 'connected')
  // While this is on screen a timeout is said here, not in a toast.
  useEffect(() => registerSignInNotice(), [])
  if (!progress) {
    if (!timedOut || signedIn) {
      return null
    }
    return (
      <p role="status" className={cn('text-xs text-muted-foreground', className)}>
        {t('auto.components.OrcaSignInProgress.didNotFinish', 'Sign-in didn’t finish. Try again.')}
      </p>
    )
  }
  const link = progress.link
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-0.5 text-xs text-muted-foreground',
        className
      )}
    >
      <Loader2 className="mr-1.5 size-3 motion-safe:animate-spin" aria-hidden />
      <span className="pr-2">
        {link
          ? t('auto.components.OrcaSignInProgress.waiting', 'Waiting for sign-in in your browser')
          : t('auto.components.OrcaSignInProgress.signingIn', 'Signing in…')}
      </span>
      {link ? (
        <>
          <span aria-hidden>·</span>
          <Button type="button" variant="link" size="xs" onClick={() => void copySignInLink(link)}>
            {t('auto.components.OrcaSignInProgress.copyLink', 'Copy sign-in link')}
          </Button>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <Button type="button" variant="link" size="xs" onClick={cancelSignIn}>
        {t('auto.components.OrcaSignInProgress.cancel', 'Cancel')}
      </Button>
    </div>
  )
}
