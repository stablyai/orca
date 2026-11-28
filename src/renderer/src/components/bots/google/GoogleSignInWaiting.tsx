import React from 'react'
import { finishGoogleSignInWithAddress, openGoogleSignInAgain } from './google-connect-client'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { ConnectWaiting } from '../connector-connect-parts'
import { SignInAddressPaste } from '../SignInAddressPaste'
import { GoogleAccessBlockedLine } from './GoogleSignInTrouble'
import type { GoogleSignInState } from './use-google-sign-in'

/** Connect Google waits on Google's page: what to do there, Open again, the paste-back, Cancel, and
 *  (given `onNewApp`) the way out of Google's Access blocked page. */
export function GoogleSignInWaiting({
  state,
  onCancel,
  onNewApp,
  personal
}: {
  state: Extract<GoogleSignInState, { kind: 'waiting' }>
  onCancel: () => void
  onNewApp?: () => void
  personal?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const link = state.prompt?.authorizeUrl
  return (
    <div className="space-y-2">
      <ConnectWaiting
        label={t('bots.google.waiting', 'Finish connecting Google in your browser.')}
        onCancel={onCancel}
      />
      <p className="text-xs text-muted-foreground">
        {personal
          ? t(
              'bots.google.waitingHowPersonal',
              'Pick your account and click Allow. Google asks you to confirm first: click Continue.'
            )
          : t('bots.google.waitingHow', 'Pick your account and click Allow.')}
      </p>
      {link ? (
        <Button variant="link" size="inlineText" onClick={() => openGoogleSignInAgain(link)}>
          {t('bots.google.openAgain', 'Open again')}
          <ExternalLink />
        </Button>
      ) : null}
      {state.way === 'paste' ? (
        <SignInAddressPaste
          memoryKey="google"
          hint={t(
            'bots.google.pasteHint',
            'After you click Allow, the page won’t load. Paste its address here.'
          )}
          onFinish={finishGoogleSignInWithAddress}
          describeError={(error) => (error instanceof Error ? error.message : String(error))}
        />
      ) : null}
      {onNewApp ? <GoogleAccessBlockedLine onNewApp={onNewApp} /> : null}
    </div>
  )
}
