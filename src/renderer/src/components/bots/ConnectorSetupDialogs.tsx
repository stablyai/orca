import React, { useState } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import { toast } from 'sonner'
import { readBotGitHub } from '@/lib/bot-github-state'
import { openGitHubInstall } from '@/lib/bot-github-install-record'
import type { BotConnectorId } from './AddConnectorDialog'
import { openGitHubInstallPage } from './github/github-install-page'
import { BotLinearSetupDialog } from './linear/BotLinearSetupDialog'
import { BotSlackSetupDialog } from './slack/BotSlackSetupDialog'
import { useTurnOnBotGoogle } from './google/use-turn-on-bot-google'
import { refreshGoogle } from './google/google-connect-client'
import { GoogleHostChoiceDialog } from './google/GoogleHostChoiceDialog'
import {
  answerGoogleSetup,
  startGoogleSetupInChat
} from './google/setup-cards/google-setup-run-store'
import { botErrorMessage } from './bot-presentation'
import { handOffConnectorSetup } from './connector-setup-handoff'
import type { Bot } from '../../../../shared/bot-types'
import { googleBotConnectState } from '../../../../shared/google/google-bot-connect-state'

/** Each account connector's own setup, as Add connector opens it; `start` opens one. */
export function useConnectorSetup(bot: Bot): {
  start: (connector: BotConnectorId) => void
  dialogs: React.JSX.Element
} {
  const [setupOpen, setSetupOpen] = useState<BotConnectorId | null>(null)
  const turnOnGoogle = useTurnOnBotGoogle()
  const start = (connector: BotConnectorId): void => {
    if (handOffConnectorSetup(bot, connector)) {
      return
    }
    if (connector === 'google') {
      void refreshGoogle(botTarget(bot)).then((view) => {
        const host =
          view.status === 'ready'
            ? googleBotConnectState({
                allowed: bot.google === true,
                client: view.google.client,
                accounts: view.google.accounts
              }).host
            : 'no-app'
        if (host === 'connected') {
          void turnOnGoogle(bot)
        } else if (host === 'no-app') {
          setSetupOpen('google')
        } else {
          // The app is here: only the owner's sign-in is left, on the setup's own sign-in card.
          void startGoogleSetupInChat(bot, 'add-connector')
            .then(() => answerGoogleSetup(bot, 'path', ['import']))
            .catch((error: unknown) => toast.error(botErrorMessage(error)))
        }
      })
      return
    }
    const github = readBotGitHub(bot.hostId)
    // Another org: GitHub's install page, where the owner picks it; its row shows once installed.
    if (connector === 'github' && bot.github && github.status === 'ready') {
      openGitHubInstallPage(bot, github.github.installUrl)
      return
    }
    // Its own always-mounted dialog: minimized to the pill, it outlives this bot's page.
    if (connector === 'github') {
      openGitHubInstall(bot)
      return
    }
    setSetupOpen(connector)
  }
  const dialogs = (
    <>
      <BotSlackSetupDialog
        bot={bot}
        open={setupOpen === 'slack'}
        onOpenChange={(next) => setSetupOpen(next ? 'slack' : null)}
      />
      <BotLinearSetupDialog
        bot={bot}
        open={setupOpen === 'linear'}
        onOpenChange={(next) => setSetupOpen(next ? 'linear' : null)}
      />
      <GoogleHostChoiceDialog
        bot={bot}
        open={setupOpen === 'google'}
        onOpenChange={(next) => setSetupOpen(next ? 'google' : null)}
      />
    </>
  )
  return { start, dialogs }
}
