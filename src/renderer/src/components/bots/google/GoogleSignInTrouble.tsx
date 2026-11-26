import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { GOOGLE_SIGN_IN_EXPIRED } from '../../../../../shared/google/google-connect-types'

/** Google's Access blocked page never returns to Orca, so the way out is offered up front. */
export function GoogleAccessBlockedLine({ onNewApp }: { onNewApp: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="text-xs text-muted-foreground">
      {t('bots.google.accessBlocked', 'Seeing ‘Access blocked’?')}{' '}
      <Button variant="link" size="inlineText" onClick={onNewApp}>
        {t('bots.google.setUpNewApp', 'Set up a new Google app')}
      </Button>
    </p>
  )
}

/** A failed sign-in's error; an expired one (often Access blocked) also offers a new app. */
export function GoogleSignInFailed({
  error,
  onNewApp,
  className
}: {
  error: string
  onNewApp?: () => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={className}>
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
      {onNewApp && error === GOOGLE_SIGN_IN_EXPIRED ? (
        <GoogleAccessBlockedLine onNewApp={onNewApp} />
      ) : null}
    </div>
  )
}
