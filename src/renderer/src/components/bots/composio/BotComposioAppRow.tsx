// An app the bot signed in to through Composio, as a row of its connectors. Composio holds the
// sign-in and anyone who can ask the bot can use the app, so the row has no people of its own.
import React from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { ComposioConnection } from '../../../../../shared/composio/composio-apps'
import {
  composioAppLine,
  composioAppName
} from '../../../../../shared/composio/composio-curated-apps'
import { BotToolLogo } from '../apps/BotToolAppRow'
import { BotConnectorDetails, BotConnectorRowFrame, type BotConnectorFix } from '../BotConnectorRow'
import { BotConnectorSection } from '../bot-connector-people'
import type { BotConnectorTitle } from '../bot-connector-titles'
import type { ComposioProblem } from '../bot-connector-entries'
import { botToolErrorMessage } from '../bot-tools-client'
import { ComposioAppLogo } from './ComposioAppLogo'
import {
  connectComposioApp,
  disconnectComposioApp,
  openBotToolsSettings,
  rereadComposioBot
} from './composio-client'

/** A Composio problem's line and its one fix: a new key in Tools, or reading the sign-ins again. */
function useComposioProblemFace(
  bot: Bot,
  problem: Exclude<ComposioProblem, null>
): { status: string; fix: BotConnectorFix } {
  const t = useTranslate()
  return problem === 'key'
    ? {
        status: t('bots.composio.keyRejected', 'Key not accepted'),
        fix: {
          label: t('bots.composio.fixKey', 'Fix key'),
          onClick: () => openBotToolsSettings(bot.id)
        }
      }
    : {
        status: t('bots.composio.signInsUnreadShort', 'Couldn’t read sign-ins'),
        fix: {
          label: t('bots.composio.checkAgain', 'Check again'),
          onClick: () => rereadComposioBot(bot)
        }
      }
}

/** Composio is in trouble before any of the bot's sign-ins were read: one row to fix it. */
export function BotComposioProblemRow({
  bot,
  problem,
  title,
  defaultOpen
}: {
  bot: Bot
  problem: Exclude<ComposioProblem, null>
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const face = useComposioProblemFace(bot, problem)
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotToolLogo name="composio" />}
      name={title ?? t('bots.composio.toolName', 'Composio apps')}
      description={face.status}
      status={null}
      fix={face.fix}
      actions={{}}
      defaultOpen={defaultOpen}
    >
      <BotConnectorSection>
        <p className="text-xs leading-5 text-muted-foreground">
          {problem === 'key'
            ? t(
                'bots.composio.keyRejectedRow',
                'All of {{bot}}’s Composio apps are paused until the key is replaced. Your connections are kept at Composio.',
                { bot: bot.name }
              )
            : t(
                'bots.composio.signInsUnreadNote',
                'Orca couldn’t ask Composio which apps {{bot}} uses.',
                {
                  bot: bot.name
                }
              )}
        </p>
      </BotConnectorSection>
    </BotConnectorRowFrame>
  )
}

export function BotComposioAppRow({
  bot,
  connection,
  problem,
  title,
  defaultOpen
}: {
  bot: Bot
  connection: ComposioConnection
  /** The whole project's trouble, which pauses this app too. */
  problem: ComposioProblem
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const name = composioAppName(connection.app, connection.name)
  const uses = composioAppLine(connection.app, [])
  const working = connection.status === 'active'
  const run = (action: () => Promise<unknown>): void =>
    void action().catch((error: unknown) => toast.error(botToolErrorMessage(error)))
  const signIn = (): void => run(() => connectComposioApp(bot, connection.app))
  const disconnect = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.composio.disconnectTitle', 'Disconnect {{app}}?', { app: name }),
      description: t(
        'bots.composio.disconnectNote',
        '{{bot}} can no longer use {{app}}. You can connect it again any time.',
        { bot: bot.name, app: name }
      ),
      confirmLabel: t('bots.composio.disconnect', 'Disconnect'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      run(() => disconnectComposioApp(bot, connection.id))
    }
  }
  const via = t('bots.composio.viaComposio', 'via Composio')
  const problemFace = useComposioProblemFace(bot, problem ?? 'unread')
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<ComposioAppLogo slug={connection.app} size="lg" />}
      name={title ?? name}
      defaultOpen={defaultOpen}
      description={
        problem
          ? `${problemFace.status} · ${via}`
          : working
            ? connection.label
              ? `${connection.label} · ${via}`
              : via
            : t('bots.composio.signedOut', 'Signed out · {{via}}', { via })
      }
      status={null}
      fix={
        problem
          ? problemFace.fix
          : working
            ? null
            : { label: t('bots.composio.signIn', 'Sign in'), onClick: signIn }
      }
      actions={{
        link: working
          ? { label: t('bots.composio.signInAgainMenu', 'Sign in again'), onClick: signIn }
          : null,
        remove: {
          label: t('bots.composio.disconnectNamed', 'Disconnect {{app}}', { app: name }),
          onSelect: () => void disconnect()
        }
      }}
    >
      <BotConnectorDetails
        rows={[
          ...(uses ? [{ label: t('bots.composio.uses', 'Uses'), value: uses }] : []),
          {
            label: t('bots.composio.people', 'People'),
            value: t('bots.composio.peopleNote', 'Anyone who can ask {{bot}} can use it', {
              bot: bot.name
            })
          },
          {
            label: t('bots.composio.signInLabel', 'Sign-in'),
            value: t('bots.composio.signInHeld', 'Held by Composio')
          }
        ]}
      />
    </BotConnectorRowFrame>
  )
}
