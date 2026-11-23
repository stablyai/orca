// Where the setup is stuck, from the host's reading, and the buttons that move it on. A press that
// fixes something on this computer (a new sign-in, an imported key) then tells the bot with a card
// answer, so it wakes and checks again instead of waiting for a chat message.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotRef } from '@/lib/bot-hosts'
import {
  googleSetupAccount,
  type GoogleSetupAction,
  type GoogleSetupBlocker
} from '../../../../../../shared/google/google-setup-blocker'
import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'
import { googleSetupActionAnswer } from '../../../../../../shared/google/google-setup-card-view'
import {
  googleEnableApisUrl,
  withGoogleAccount
} from '../../../../../../shared/google/google-console-setup'
import {
  importGoogleApp,
  openInMyBrowser,
  refreshGoogle,
  useGoogleHost
} from '../google-connect-client'
import { googleAdminRequest } from '../google-copy'
import { useGoogleClientFile } from '../use-google-client-file'
import type { useGoogleSignIn } from '../use-google-sign-in'
import { googleSetupActionText, googleSetupBlockerText } from './google-setup-blocker-copy'
import { answerGoogleSetup } from './google-setup-run-store'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function GoogleSetupBlockerPanel({
  bot,
  run,
  blocker,
  signIn
}: {
  bot: BotRef
  run: GoogleSetupRun
  blocker: GoogleSetupBlocker
  /** The card's own sign-in, so Allow and Sign in again show its waiting state. */
  signIn?: ReturnType<typeof useGoogleSignIn>
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const host = useGoogleHost(botTarget(bot))
  const client = host.status === 'ready' ? host.google.client : null
  const accounts = host.status === 'ready' ? host.google.accounts : []
  const answer = (values: string[]): Promise<void> => answerGoogleSetup(bot, 'step', values)
  const file = useGoogleClientFile(async (text) => {
    await importGoogleApp(botTarget(bot), text)
    const client = run.steps.client?.status
    await answer(client === 'done' || client === 'skipped' ? ['resume'] : ['done', 'client'])
  })
  // A new sign-in fixes it on this computer; the bot hears so it runs done again.
  const signInThen = async (
    services: GoogleSetupRun['services'],
    email: string | undefined
  ): Promise<void> => {
    if (!signIn) {
      return
    }
    const account = await signIn.connect(services ?? run.services ?? ['gmail'], email)
    if (account) {
      await answer(['resume'])
    }
  }
  // Asks Google again; once it answers, the bot hears and runs done again.
  const checkAgain = async (): Promise<void> => {
    const view = await refreshGoogle(botTarget(bot), { check: true })
    if (view.status === 'failed') {
      throw new Error(view.error)
    }
    await answer(['resume'])
  }
  const press = async (action: GoogleSetupAction): Promise<void> => {
    switch (action.id) {
      case 'make-new-key':
      case 'continue-without':
      case 'keep-account':
      case 'continue':
      case 'start-over':
      case 'let-me':
      case 'done': {
        const answered = googleSetupActionAnswer(action, run)
        return answered ? answerGoogleSetup(bot, answered.card, answered.values) : undefined
      }
      case 'import-key':
        return file.pick()
      case 'allow':
        return signInThen(action.services, run.account)
      case 'sign-in-again':
        return signInThen(run.services, action.email)
      case 'turn-on': {
        // An imported app names no project or account on the run; its key and sign-in do.
        const projectId = run.projectId ?? client?.projectId
        openInMyBrowser(
          withGoogleAccount(
            googleEnableApisUrl(action.services, projectId ? { projectId } : {}),
            googleSetupAccount(run, accounts)?.email
          )
        )
        return
      }
      case 'copy-for-admin':
        if (client) {
          await window.api.ui.writeClipboardText(googleAdminRequest(client.clientId))
          toast.success(t('bots.google.copied', 'Copied. Send it to your Google admin.'))
        }
        return
      case 'check-again':
        return checkAgain()
    }
  }
  const act = (action: GoogleSetupAction): void => {
    setBusy(true)
    void press(action)
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setBusy(false))
  }
  const [primary, quieter] = blocker.actions
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-sm font-medium text-foreground">{googleSetupBlockerText(blocker)}</p>
      {file.error ? (
        <p role="alert" className="text-xs text-destructive">
          {file.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {primary ? (
          <Button size="xs" disabled={busy || file.busy} onClick={() => act(primary)}>
            {googleSetupActionText(primary)}
          </Button>
        ) : null}
        {quieter ? (
          <Button
            variant="link"
            size="inlineText"
            disabled={busy || file.busy}
            onClick={() => act(quieter)}
          >
            {googleSetupActionText(quieter)}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
