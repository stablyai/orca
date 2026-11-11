import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
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
 * Stays clickable while a sign-in is pending: another click starts a fresh sign-in in the browser
 * and replaces the pending one (main cancels it), so a closed or lost tab never strands the user.
 */
export function OrcaSignInButton({
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'onClick' | 'type'>): React.JSX.Element {
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  return (
    <Button {...props} type="button" onClick={() => void connect()}>
      {children}
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
