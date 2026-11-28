// An app the bot has as a tool, as a row of its connectors. Orca holds the sign-in of an app added
// now, whichever agent the bot runs; an older one's is held by the bot's agent's CLI.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { botAgentLabel } from '../bot-presentation'
import { botToolSubtitle, botToolTitle } from '../../../../../shared/bots/bot-tool-labels'
import { botToolErrorMessage, removeBotTool } from '../bot-tools-client'
import { useBotToolSignInAction } from '../bot-tool-sign-in-action'
import { retryBotToolCheck } from '../bot-tools-revision'
import { BotConnectorDetails, BotConnectorRowFrame, type BotConnectorFix } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { BotToolFinishSignIn } from '../BotToolFinishSignIn'
import type { BotToolApp } from './bot-tool-apps'
import { botMcpAppLine } from '../../../../../shared/bots/bot-app-lines'
import { botToolAppSignsIn } from '../../../../../shared/bots/bot-connector-entries'
import { botToolAppCheckFace } from './bot-tool-app-check-face'
import { AddBotToolDialog } from '../AddBotToolDialog'
import { BotToolLogo } from './BotToolLogo'

// Kept importable from here for the rows that already do; its own module breaks an import cycle.
export { BotToolLogo }

export function BotToolAppRow({
  bot,
  entry,
  title,
  defaultOpen
}: {
  bot: Bot
  entry: BotToolApp
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const { tool, app, problem } = entry
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const name = app?.name ?? botToolTitle(tool.name)
  const line = app ? botMcpAppLine(app, t) : botToolSubtitle(tool)
  const run = (action: () => Promise<unknown>): void => {
    setBusy(true)
    void action()
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
      .finally(() => setBusy(false))
  }
  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.toolApp.removeTitle', 'Remove {{app}}?', { app: name }),
      description: t(
        'bots.toolApp.removeNote',
        '{{bot}} can no longer use {{app}}. You can add it again any time.',
        { bot: bot.name, app: name }
      ),
      confirmLabel: t('bots.toolApp.remove', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      run(() => removeBotTool(bot, tool.name))
    }
  }
  const checkAgain: BotConnectorFix = {
    label: t('bots.toolApp.checkAgain', 'Check again'),
    onClick: retryBotToolCheck,
    disabled: busy
  }
  const owned = tool.signIn
  const signsIn = botToolAppSignsIn(entry)
  const signInAction = useBotToolSignInAction(bot, tool, problem)
  const { started } = signInAction
  const found = botToolAppCheckFace(problem, started)
  // The same Edit as Settings › Tools: the name to change is the bot's tool's.
  const rename: BotConnectorFix = {
    label: t('settings.bots.edit', 'Edit'),
    onClick: () => setEditing(true),
    disabled: busy
  }
  const wontStart = t('bots.toolApp.wontStart', 'Won’t start')
  // What the check found says so over the sign-in, which stays as it is; both failures read
  // "Won't start" in the list, and Edit or Check again waits on the opened page.
  const checkFace: { line: string; fix: BotConnectorFix } | null =
    found === 'nameTaken' || found === 'wontStart'
      ? {
          line: wontStart,
          fix: { ...(found === 'nameTaken' ? rename : checkAgain), listLabel: wontStart }
        }
      : found === 'unconfirmed'
        ? { line: t('bots.toolApp.unconfirmed', 'Not confirmed'), fix: checkAgain }
        : null
  const face: { line: string; fix: BotConnectorFix | null } = checkFace
    ? checkFace
    : signInAction.line
      ? {
          line: signInAction.line,
          fix: signInAction.action && {
            label: signInAction.action.label,
            onClick: signInAction.action.run,
            disabled: busy || signInAction.action.busy,
            opensRow: true
          }
        }
      : {
          line:
            !problem && signsIn && app?.signIn === 'browser'
              ? t('bots.toolApp.signedIn', 'Signed in')
              : line,
          fix: null
        }
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotToolLogo name={tool.name} detail={tool.detail} />}
      name={title ?? name}
      description={face.line}
      status={null}
      checking={!owned && problem?.kind === 'unconfirmed' && !problem.detail}
      fix={face.fix}
      defaultOpen={defaultOpen === true || started}
      actions={{
        link:
          (owned ? owned.state !== 'signed-in' : problem?.kind === 'sign-in') ||
          !signsIn ||
          // Signing in again can't free a name Codex's config already has.
          found === 'nameTaken'
            ? null
            : {
                label: t('bots.toolApp.signInAgain', 'Sign in again'),
                onClick: signInAction.signIn
              },
        remove: {
          label: t('bots.toolApp.removeNamed', 'Remove {{app}}', { app: name }),
          onSelect: () => void remove(),
          disabled: busy
        }
      }}
    >
      <BotConnectorDetails
        rows={[
          ...(app ? [{ label: t('bots.toolApp.uses', 'Uses'), value: botMcpAppLine(app, t) }] : []),
          {
            label: t('bots.toolApp.address', 'Address'),
            value: <span className="font-mono break-all">{tool.detail}</span>
          },
          {
            label: t('bots.toolApp.people', 'People'),
            value: t('bots.toolApp.peopleNote', 'Anyone who can ask {{bot}} can use it', {
              bot: bot.name
            })
          },
          ...(!signsIn
            ? []
            : [
                {
                  label: t('bots.toolApp.signInLabel', 'Sign-in'),
                  value: owned
                    ? t('bots.toolApp.signInOrca', 'Works with Claude and Codex')
                    : problem?.kind === 'sign-in'
                      ? t('bots.toolApp.signInMissing', '{{agent}} isn’t signed in', {
                          agent: botAgentLabel(bot.agent)
                        })
                      : t('bots.toolApp.signInHeld', 'Held by {{agent}}', {
                          agent: botAgentLabel(bot.agent)
                        })
                }
              ])
        ]}
      />
      {signInAction.pasteBack ? <BotToolFinishSignIn bot={bot} name={tool.name} openAgain /> : null}
      <AddBotToolDialog bot={bot} name={tool.name} open={editing} onOpenChange={setEditing} />
      {(!owned || checkFace) && problem?.detail ? (
        <p className="mt-2 font-mono text-xs leading-5 text-muted-foreground">{problem.detail}</p>
      ) : null}
    </BotConnectorRowFrame>
  )
}
