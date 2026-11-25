// A Google setup card in a bot's chat, drawn from the bot's setup run rather than from the item, so
// every client shows it the same and it follows the run as the bot moves it.
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import {
  isNewestGoogleSetupCard,
  type GoogleSetupCardRef
} from '../../../../../../shared/google/google-setup-card'
import {
  GoogleSetupAccountCard,
  GoogleSetupPathCard,
  GoogleSetupServicesCard
} from './GoogleSetupChoiceCards'
import { GoogleSetupConnectCard, GoogleSetupConnectedCard } from './GoogleSetupConnectCards'
import { GoogleSetupProgressCard, GoogleSetupStepCard } from './GoogleSetupProgressCards'
import { useGoogleSetupRun } from './google-setup-run-store'

export function GoogleSetupChatCard({
  card,
  fallback
}: {
  card: GoogleSetupCardRef
  /** The host's line, for a bot or run this window can't read. */
  fallback: string
}): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const bot = useBots().find((entry) => entry.id === card.botId)
  const run = useGoogleSetupRun(bot ?? null, card.runId)
  if (!bot || !run) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  if (run.id !== card.runId) {
    return (
      <p className="text-sm text-chat-foreground-faint">
        {t('bots.googleSetup.ended', 'This Google setup ended.')}
      </p>
    )
  }
  // Ordered by the copy number Orca wrote, so scrolling older history in never moves the buttons.
  const newest = isNewestGoogleSetupCard(run, card)
  switch (card.card) {
    case 'path':
      return <GoogleSetupPathCard bot={bot} botName={bot.name} run={run} />
    case 'account':
      return <GoogleSetupAccountCard bot={bot} accounts={run.accounts ?? []} run={run} />
    case 'services':
      return <GoogleSetupServicesCard bot={bot} run={run} />
    case 'progress':
      return <GoogleSetupProgressCard bot={bot} botName={bot.name} run={run} newest={newest} />
    case 'step':
      return card.step ? (
        <GoogleSetupStepCard
          bot={bot}
          botName={bot.name}
          step={card.step}
          run={run}
          newest={newest}
        />
      ) : (
        <p className="text-sm text-chat-foreground-faint">{fallback}</p>
      )
    case 'connect':
      return <GoogleSetupConnectCard bot={bot} run={run} newest={newest} />
    case 'connected':
      return <GoogleSetupConnectedCard bot={bot} botName={bot.name} run={run} />
  }
}
