// The Connect card for an app Composio has no sign-in of its own for: the owner's one-time setup in
// Composio, then Check again, which turns the card into the app's Connect once Composio has it.
import React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { COMPOSIO_PAGES, composioAppGuideUrl } from '../../../../../shared/composio/composio-apps'
import { openComposioPage } from './composio-client'

export function ComposioAppSetUpSteps({
  app,
  checking,
  stillMissing,
  onCheckAgain
}: {
  app: { slug: string; name: string }
  checking: boolean
  /** A Check again found no setup yet. */
  stillMissing: boolean
  onCheckAgain: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const steps = [
    t(
      'bots.composio.setUpSteps.developerApp',
      'Create a developer app on {{app}}’s developer site. Composio’s {{app}} page shows how.',
      { app: app.name }
    ),
    t(
      'bots.composio.setUpSteps.authConfig',
      'In Composio, open Auth Configs, add one for {{app}}, and paste your developer app’s keys.',
      { app: app.name }
    ),
    t('bots.composio.setUpSteps.checkAgain', 'Come back here and choose Check again.')
  ]
  return (
    <>
      <div className="mt-0.5 text-sm font-medium text-foreground">
        {t('bots.composio.setUpSteps.title', '{{app}} needs a one-time setup in Composio', {
          app: app.name
        })}
      </div>
      <ol className="mt-1 flex list-decimal flex-col gap-0.5 pl-4 text-xs text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {stillMissing ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {t('bots.composio.setUpSteps.notYet', 'Composio has no Auth Config for {{app}} yet.', {
            app: app.name
          })}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="xs" onClick={() => openComposioPage(COMPOSIO_PAGES.authConfigs)}>
          {t('bots.composio.setUpSteps.openAuthConfigs', 'Open Auth Configs')}
          <ExternalLink />
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => openComposioPage(composioAppGuideUrl(app.slug))}
        >
          {t('bots.composio.setUpSteps.guide', '{{app}} page', { app: app.name })}
          <ExternalLink />
        </Button>
        <Button size="xs" variant="ghost" disabled={checking} onClick={onCheckAgain}>
          {t('bots.composio.checkAgain', 'Check again')}
        </Button>
      </div>
    </>
  )
}
