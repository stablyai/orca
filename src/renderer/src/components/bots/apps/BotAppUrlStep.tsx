// Add by URL and the catalog's MCP apps: the bot's Tools editor (or the app's own URL), then the
// server's browser sign-in, waited for here.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotOwnTool } from '../../../../../shared/bot-tools'
import {
  botMcpAppUrlPlace,
  type BotMcpAppUrlVariable
} from '../../../../../shared/bots/bot-mcp-apps'
import { LoadedEditor } from '../AddBotToolDialog'
import {
  addBotTool,
  botToolErrorMessage,
  connectBotTool,
  readBotOwnTools
} from '../bot-tools-client'
import { BotAppLogo } from './BotAppRow'
import { BotAppOutcome, BotAppStepHeader, BotAppStepHeading } from './BotAppStepParts'
import { BotAppUrlVariableForm } from './BotAppUrlVariableForm'
import { ToolSignIn, ToolSignInFailed } from './BotAppToolSignIn'

const FORM_BODY = 'px-6 pt-1 pb-6'

export type CustomPhase =
  | { kind: 'edit' }
  /** An app whose URL has a blank: its site or host, given before it is added. */
  | { kind: 'variable'; app: BotMcpAppPreset; variable: BotMcpAppUrlVariable }
  | { kind: 'adding' }
  /** Another site or host of the app is on the bot already; one tool per name. */
  /** `place`: the site or host it is at, when the app's template makes its URL. */
  | { kind: 'elsewhere'; app: string; place: string | null }
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

const webHref = (url: string): string => {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

const urlLogo = (size: 'md' | 'lg') => (
  <BotAppLogo plain icon={<Link2 className={size === 'lg' ? 'size-5' : 'size-4'} />} size={size} />
)

/** An MCP app the catalog lists: added by its URL under its own name, no editor. */
export type BotMcpAppPreset = {
  name: string
  title: string
  line: string
  url: string
  variable?: BotMcpAppUrlVariable
  logo: React.ReactNode
}

/**
 * Add by URL: the bot's Tools editor, then the server's browser sign-in, waited for here. With a
 * preset (an MCP app from the catalog) the tool is added straight from its URL, once its site is
 * given when its URL has a blank.
 */
export function CustomAppStep({
  bot,
  preset,
  onBack,
  onClose,
  onManage
}: {
  bot: Bot
  preset?: BotMcpAppPreset
  onBack: () => void
  onClose: () => void
  /** The bot's apps, where one on the bot already is managed. */
  onManage: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [phase, setPhase] = useState<CustomPhase>(
    preset?.variable
      ? { kind: 'variable', app: preset, variable: preset.variable }
      : { kind: preset ? 'adding' : 'edit' }
  )
  // The URL last added, which Try again adds again.
  const addedUrl = useRef(preset?.url ?? '')
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
    (app: BotMcpAppPreset, url: string) => {
      addedUrl.current = url
      setPhase({ kind: 'adding' })
      void addBotTool({ hostId, id: botId }, url, app.name).then(added, (error: unknown) =>
        setPhase({ kind: 'failed', name: app.name, owned: true, error: botToolErrorMessage(error) })
      )
    },
    [hostId, botId, added]
  )
  // Once per step: the parent redraws with a fresh preset object.
  const addStarted = useRef(false)
  useEffect(() => {
    if (!preset || preset.variable || addStarted.current) {
      return
    }
    addStarted.current = true
    add(preset, preset.url)
  }, [add, preset])
  // Try again resumes where it failed, by whether the host has the tool: add it, or sign in to it,
  // unless the tool under that name is another site or host of the app (another window added it).
  const retry = (name: string, owned: boolean): void => {
    void readBotOwnTools(bot).then(
      (tools) => {
        const saved = tools.find((tool) => tool.name === name)
        if (saved && preset && webHref(saved.detail) !== webHref(addedUrl.current)) {
          setPhase({
            kind: 'elsewhere',
            app: preset.title,
            place: botMcpAppUrlPlace(preset, saved.detail)?.name ?? null
          })
        } else if (saved) {
          signIn(name, owned)
        } else if (preset) {
          add(preset, addedUrl.current)
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
  if (phase.kind === 'elsewhere') {
    return (
      <>
        <BotAppStepHeader onClose={onClose} />
        <BotAppOutcome
          logo={appLogo}
          badge="failed"
          title={t('bots.apps.mcp.elsewhereTitle', '{{app}} is already on {{bot}}', {
            app: phase.app,
            bot: bot.name
          })}
          line={
            phase.place
              ? t(
                  'bots.apps.mcp.elsewhereLine',
                  'It’s added at {{place}}. Remove it in Manage to add another.',
                  { place: phase.place }
                )
              : t('bots.apps.mcp.elsewhereOther', 'Remove it in Manage to add another.')
          }
          actions={
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>
                {t('bots.apps.close', 'Close')}
              </Button>
              <Button size="sm" onClick={onManage}>
                {t('bots.connectors.manage', 'Manage')}
              </Button>
            </>
          }
        />
      </>
    )
  }
  if (phase.kind === 'variable') {
    const { app, variable } = phase
    return (
      <>
        <BotAppStepHeader onBack={onBack} onClose={onClose} />
        <BotAppUrlVariableForm
          className={FORM_BODY}
          app={app}
          variable={variable}
          onAdd={(url) => add(app, url)}
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
