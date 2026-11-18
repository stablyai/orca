// Add by URL and the catalog's MCP apps: the bot's Tools editor (or the app's own URL), then the
// server's browser sign-in, waited for here.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotOwnTool } from '../../../../../shared/bot-tools'
import { LoadedEditor } from '../AddBotToolDialog'
import { BotToolFinishSignIn } from '../BotToolFinishSignIn'
import {
  addBotTool,
  botToolErrorMessage,
  useBotToolHostSignIn,
  connectBotTool,
  openBotToolSignInPage,
  readBotToolNames,
  removeBotTool,
  useBotToolSignIn
} from '../bot-tools-client'
import { updateLine } from '../bot-tool-sign-in-action'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import { BotAppLogo } from './BotAppRow'
import {
  BotAppBrowserWait,
  BotAppOutcome,
  BotAppStepHeader,
  BotAppStepHeading
} from './BotAppStepParts'

const FORM_BODY = 'px-6 pt-1 pb-6'

type CustomPhase =
  | { kind: 'edit' }
  | { kind: 'adding' }
  /** owned: Orca signs in (pasted back only when its host runs it); else the tool's agent CLI does. */
  | {
      kind: 'signing'
      name: string
      owned: boolean
      url: string | null
      attempt: number
      paste: boolean
    }
  | { kind: 'failed'; name: string; owned: boolean; error?: string }
  | { kind: 'done'; name: string }

const urlLogo = (size: 'md' | 'lg') => (
  <BotAppLogo plain icon={<Link2 className={size === 'lg' ? 'size-5' : 'size-4'} />} size={size} />
)

/** An MCP app the catalog lists: added by its URL under its own name, no editor. */
export type BotMcpAppPreset = { name: string; title: string; url: string; logo: React.ReactNode }

/**
 * Add by URL: the bot's Tools editor, then the server's browser sign-in, waited for here. With a
 * preset (an MCP app from the catalog) the tool is added straight from its URL.
 */
export function CustomAppStep({
  bot,
  preset,
  onBack,
  onClose
}: {
  bot: Bot
  preset?: BotMcpAppPreset
  onBack: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [phase, setPhase] = useState<CustomPhase>({ kind: preset ? 'adding' : 'edit' })
  const attempts = useRef(0)
  const { hostId, id: botId } = bot
  const signIn = useCallback(
    (name: string, owned: boolean) => {
      const attempt = (attempts.current += 1)
      setPhase({ kind: 'signing', name, owned, url: null, attempt, paste: false })
      // Null: the agent's CLI opened the browser itself; the wait still ends on the host's word.
      void connectBotTool({ hostId, id: botId }, name, owned).then(
        (url) =>
          setPhase((current) =>
            current.kind === 'signing' && current.attempt === attempt
              ? { ...current, url }
              : current
          ),
        (error: unknown) =>
          setPhase({ kind: 'failed', name, owned, error: botToolErrorMessage(error) })
      )
    },
    [hostId, botId]
  )
  // A new address that needs a sign-in is one Orca signs in to; any other is ready as added.
  const added = useCallback(
    (tool: BotOwnTool) =>
      tool.signIn ? signIn(tool.name, true) : setPhase({ kind: 'done', name: tool.name }),
    [signIn]
  )
  const add = useCallback(
    (app: BotMcpAppPreset) => {
      setPhase({ kind: 'adding' })
      void addBotTool({ hostId, id: botId }, app.url, app.name).then(added, (error: unknown) =>
        setPhase({ kind: 'failed', name: app.name, owned: true, error: botToolErrorMessage(error) })
      )
    },
    [hostId, botId, added]
  )
  // Once per step: the parent redraws with a fresh preset object.
  const addStarted = useRef(false)
  useEffect(() => {
    if (!preset || addStarted.current) {
      return
    }
    addStarted.current = true
    add(preset)
  }, [add, preset])
  // Try again resumes where it failed, by whether the host has the tool: add it, or sign in to it.
  const retry = (name: string, owned: boolean): void => {
    void readBotToolNames(bot).then(
      (names) => {
        if (names.has(name)) {
          signIn(name, owned)
        } else if (preset) {
          add(preset)
        } else {
          setPhase({ kind: 'edit' })
        }
      },
      (error: unknown) =>
        setPhase({ kind: 'failed', name, owned, error: botToolErrorMessage(error) })
    )
  }
  const appLogo = preset ? preset.logo : urlLogo('lg')
  const appTitle = (name: string) => (preset && name === preset.name ? preset.title : name)
  if (phase.kind === 'adding') {
    return (
      <>
        <BotAppStepHeader onBack={onBack} onClose={onClose} />
        <BotAppOutcome
          logo={appLogo}
          title={t('bots.apps.mcp.adding', 'Adding {{app}}…', { app: preset?.title ?? '' })}
          line={null}
          actions={null}
        />
      </>
    )
  }
  if (phase.kind === 'edit') {
    return (
      <>
        <BotAppStepHeader onBack={onBack} onClose={onClose} />
        <div className={FORM_BODY}>
          <BotAppStepHeading
            logo={urlLogo('lg')}
            title={t('bots.apps.custom.title', 'Add an app by URL')}
            line={t('bots.apps.custom.line', 'Any MCP server {{bot}} should use', {
              bot: bot.name
            })}
          />
          <LoadedEditor bot={bot} close={onBack} onSavingChange={() => undefined} onSaved={added} />
        </div>
      </>
    )
  }
  if (phase.kind === 'signing') {
    return (
      <ToolSignIn
        bot={bot}
        phase={phase}
        logo={appLogo}
        title={appTitle(phase.name)}
        onPaste={(paste) => setPhase({ ...phase, paste })}
        onOpenAgain={phase.owned ? () => signIn(phase.name, true) : undefined}
        onEnded={(outcome) =>
          setPhase(
            outcome === 'done'
              ? { kind: 'done', name: phase.name }
              : { kind: 'failed', name: phase.name, owned: phase.owned }
          )
        }
        onClose={onClose}
      />
    )
  }
  if (phase.kind === 'failed') {
    return (
      <ToolSignInFailed
        bot={bot}
        phase={phase}
        logo={appLogo}
        app={appTitle(phase.name)}
        onRetry={() => retry(phase.name, phase.owned)}
        onError={(error) => setPhase({ ...phase, error })}
        onClose={onClose}
      />
    )
  }
  return (
    <>
      <BotAppStepHeader onClose={onClose} />
      <BotAppOutcome
        logo={appLogo}
        badge="done"
        title={t('bots.apps.custom.done', '{{app}} is on {{bot}}', {
          app: appTitle(phase.name),
          bot: bot.name
        })}
        line={t('bots.apps.custom.doneLine', '{{bot}} can use its tools from its next turn.', {
          bot: bot.name
        })}
        actions={
          <Button size="sm" onClick={onClose}>
            {t('bots.apps.done', 'Done')}
          </Button>
        }
      />
    </>
  )
}

/** A sign-in that didn't finish: why, as this window last heard it, with Try again or Remove. */
function ToolSignInFailed({
  bot,
  phase,
  logo,
  app,
  onRetry,
  onError,
  onClose
}: {
  bot: Bot
  phase: Extract<CustomPhase, { kind: 'failed' }>
  logo: React.ReactNode
  app: string
  onRetry: () => void
  onError: (error: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const signIn = useBotToolSignIn(bot, phase.name)
  const failure = phase.owned ? signIn.failure : undefined
  const unsupported = failure === 'unsupported'
  const title = unsupported
    ? t('bots.apps.unsupported', 'This app isn’t supported yet')
    : failure === 'needs-update'
      ? updateLine(t, signIn.hostName)
      : failure === 'unavailable'
        ? t('bots.apps.cantReach', 'Can’t reach {{app}}', { app })
        : t('bots.apps.couldNotSignIn', 'Couldn’t sign in to {{app}}', { app })
  const line =
    failure === 'denied'
      ? t('bots.apps.accessNotAllowed', 'Access wasn’t allowed.')
      : failure === 'expired'
        ? t('bots.apps.signInExpired', 'The sign-in expired.')
        : unsupported || failure === 'unavailable' || failure === 'needs-update'
          ? null
          : (phase.error ??
            t(
              'bots.apps.custom.failedLine',
              '{{app}} is on {{bot}} but not signed in. Try again, or remove it in Settings › Tools.',
              { app, bot: bot.name }
            ))
  return (
    <>
      <BotAppStepHeader onClose={onClose} />
      <BotAppOutcome
        logo={logo}
        badge="failed"
        title={title}
        line={line}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('bots.apps.close', 'Close')}
            </Button>
            {unsupported ? (
              <Button
                size="sm"
                onClick={() =>
                  void removeBotTool(bot, phase.name).then(onClose, (error: unknown) =>
                    onError(botToolErrorMessage(error))
                  )
                }
              >
                {t('bots.toolApp.removeNamed', 'Remove {{app}}', { app })}
              </Button>
            ) : (
              <Button size="sm" onClick={onRetry}>
                {t('bots.composio.tryAgain', 'Try again')}
              </Button>
            )}
          </>
        }
      />
    </>
  )
}

/** A tool's sign-in under way: Finish in your browser, or the address pasted from another computer. */
function ToolSignIn({
  bot,
  phase,
  logo,
  title,
  onPaste,
  onOpenAgain,
  onEnded,
  onClose
}: {
  bot: Bot
  phase: Extract<CustomPhase, { kind: 'signing' }>
  logo: React.ReactNode
  title: string
  onPaste: (paste: boolean) => void
  /** Orca's own sign-in: a fresh one, since its page can't be opened twice. */
  onOpenAgain?: () => void
  onEnded: (outcome: string | undefined) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { active, outcome } = useBotToolSignIn(bot, phase.name)
  // A sign-in the bot's host runs for this device: its page is open here; its address comes back by paste.
  const host = useBotToolHostSignIn(bot, phase.name)
  const hosted = active ? host : null
  // The watch ends with the host's last word on the sign-in.
  React.useEffect(() => {
    if (!active && outcome !== undefined) {
      onEnded(outcome)
    }
  }, [active, outcome, onEnded])
  if (phase.paste) {
    return (
      <>
        <BotAppStepHeader
          backLabel={t('bots.apps.back', 'Back')}
          onBack={() => onPaste(false)}
          onClose={onClose}
        />
        <div className={FORM_BODY}>
          <BotAppStepHeading
            logo={logo}
            title={t('bots.apps.paste.title', 'Signing in on another computer?')}
            line={t(
              'bots.apps.paste.line',
              'Sign in to {{app}} there, then copy the address of the page that didn’t load.',
              { app: title }
            )}
          />
          <BotToolFinishSignIn bot={bot} name={phase.name} />
        </div>
      </>
    )
  }
  const hostedUrl = hosted?.paste ? hosted.url : null
  return (
    <>
      <BotAppStepHeader onClose={onClose} />
      <BotAppBrowserWait
        logo={logo}
        line={
          hosted?.state === 'finishing'
            ? t('bots.toolApp.finishing', 'Finishing sign-in…')
            : t('bots.apps.signInAllow', 'Sign in to {{app}} and allow access.', {
                app: title
              })
        }
        onClose={onClose}
        onOpenAgain={
          hostedUrl
            ? () => openBotToolSignInPage(hostedUrl)
            : (onOpenAgain ??
              (phase.url
                ? () => openBotHostPageOrSay(bot.hostId, phase.url ?? '', { bot, local: 'system' })
                : undefined))
        }
        footer={
          hostedUrl ? (
            <BotToolFinishSignIn bot={bot} name={phase.name} />
          ) : phase.owned ? null : (
            <Button variant="link" size="inlineText" onClick={() => onPaste(true)}>
              {t('bots.apps.paste.title', 'Signing in on another computer?')}
            </Button>
          )
        }
      />
    </>
  )
}
