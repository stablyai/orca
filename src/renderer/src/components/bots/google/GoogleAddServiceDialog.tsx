import React, { useState } from 'react'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  googleEnableApisUrl,
  withGoogleAccount
} from '../../../../../shared/google/google-console-setup'
import {
  GOOGLE_SERVICE_CHOICES,
  type GoogleServiceChoice
} from '../../../../../shared/google/google-scopes'
import { GoogleServicePicker } from './GoogleServicePicker'
import { googleChoiceLabel } from './google-copy'

/**
 * Add a service: the admin turns the new ones on for the team with one link, then each person signs
 * in once more; Google is asked for everything they had plus the new ones.
 */
export function GoogleAddServiceDialog({
  open,
  onOpenChange,
  have,
  projectId,
  account,
  onSignIn
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  have: readonly GoogleServiceChoice[]
  projectId: string | undefined
  /** Opens Google's page as this account. */
  account: string
  onSignIn: (services: GoogleServiceChoice[]) => void
}): React.JSX.Element {
  const intlLocale = useIntlLocale()
  const t = useTranslate()
  const offered = GOOGLE_SERVICE_CHOICES.filter((choice) => !have.includes(choice))
  const [picked, setPicked] = useState<GoogleServiceChoice[]>([])
  const names = new Intl.ListFormat(intlLocale, { type: 'conjunction' })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bots.google.add.title', 'Add a Google service')}</DialogTitle>
          <DialogDescription>
            {offered.length === 0
              ? t('bots.google.add.allOn', 'Your bots can already use every service.')
              : t(
                  'bots.google.add.note',
                  'Sign in once more to let your bots use it. {{have}} keeps working while you do.',
                  { have: names.format(have.map(googleChoiceLabel)) }
                )}
          </DialogDescription>
        </DialogHeader>
        {offered.length > 0 ? (
          <>
            <GoogleServicePicker value={picked} onChange={setPicked} offered={offered} />
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                {t(
                  'bots.google.add.turnOn',
                  'If you set up your team’s Google app, turn the new services on for the team.'
                )}{' '}
                <Button
                  variant="link"
                  size="inlineText"
                  disabled={picked.length === 0}
                  onClick={() =>
                    openAppHttpLink(
                      withGoogleAccount(googleEnableApisUrl(picked, { projectId }), account)
                    )
                  }
                >
                  {t('bots.google.add.openGoogle', 'Open Google')}
                  <ExternalLink />
                </Button>
              </li>
              <li>
                {t(
                  'bots.google.add.signIn',
                  'Sign in again. Anything still off for your team gets a Turn on button.'
                )}
              </li>
            </ol>
          </>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('bots.google.add.notNow', 'Not now')}
          </Button>
          {offered.length > 0 ? (
            <Button disabled={picked.length === 0} onClick={() => onSignIn([...have, ...picked])}>
              {t('bots.google.add.signInButton', 'Sign in again')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
