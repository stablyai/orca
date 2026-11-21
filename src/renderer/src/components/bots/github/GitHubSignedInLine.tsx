import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** "@login · Not you?" on one line; the login truncates, Not you? starts over with another account. */
export function GitHubSignedInLine({
  login,
  onNotYou
}: {
  login: string
  onNotYou: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const who = `@${login}`
  const signedInAs = t('bots.connect.signedInAs', 'Signed in as {{who}}', { who })
  return (
    <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
      <span className="min-w-0 truncate" title={signedInAs}>
        <span aria-hidden>{who}</span>
        <span className="sr-only">{signedInAs}</span>
      </span>
      <span aria-hidden>·</span>
      <Button variant="link-muted" size="inlineText" onClick={onNotYou}>
        {t('bots.connect.notYou', 'Not you?')}
      </Button>
    </span>
  )
}
