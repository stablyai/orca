import React, { useState } from 'react'
import { BotFeishuSetup } from './feishu/BotFeishuSetup'
import { botTarget } from '@/lib/bot-hosts'
import { toast } from 'sonner'
import { readBotGitHub } from '@/lib/bot-github-state'
import { addGitHubAccess, openGitHubInstall } from '@/lib/bot-github-install-record'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type { BotConnectorId } from './AddConnectorDialog'
import { openGitHubInstallPage } from './github/github-install-page'
import { BotLinearSetupDialog } from './linear/BotLinearSetupDialog'
import { BotSlackSetupDialog } from './slack/BotSlackSetupDialog'
import { GoogleAccountsDialog } from './google/GoogleAccountsChoice'
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

/** Each account connector's own setup, as Add connector opens it; `start` opens one. `workspace`:
 *  the org or workspace asked for, e.g. by a chat card. */
export function useConnectorSetup(bot: Bot): {
  start: (connector: BotConnectorId, options?: { workspace?: string }) => void
  dialogs: React.JSX.Element
} {
  const [setupOpen, setSetupOpen] = useState<BotConnectorId | 'google-accounts' | null>(null)
  const start = (connector: BotConnectorId, options: { workspace?: string } = {}): void => {
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
          setSetupOpen('google-accounts')
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
    // Another org: a GitHub sign-in reads what the login picked reaches, and GitHub's install page
    // opens only for an org it can't. A paired web client can't start a sign-in: the page alone.
    if (connector === 'github' && bot.github && github.status === 'ready') {
      const installPage = () => void openGitHubInstallPage(bot, github.github.installUrl)
      if (isPairedWebClientWindow()) {
        installPage()
      } else {
        addGitHubAccess(bot, options.workspace, installPage)
      }
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
      {setupOpen === 'feishu-local' ? (
        <BotFeishuSetup key={bot.id} bot={bot} onClose={() => setSetupOpen(null)} />
      ) : null}
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
      <GoogleAccountsDialog
        bot={bot}
        open={setupOpen === 'google-accounts'}
        onOpenChange={(next) => setSetupOpen(next ? 'google-accounts' : null)}
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
