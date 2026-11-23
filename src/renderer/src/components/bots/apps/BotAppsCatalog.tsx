// Add to <bot>'s body: the rail, the search and the list it filters, or the step an Add opened.
import React, { useCallback, useDeferredValue, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { COMPOSIO_PAGES } from '../../../../../shared/composio/composio-apps'
import { composioAppName } from '../../../../../shared/composio/composio-curated-apps'
import { type BotConnector, useBotConnectorState } from '../bot-connectors'
import { botToolErrorMessage } from '../bot-tools-client'
import { useBotTools } from '../bot-tool-checks'
import {
  addComposioTool,
  connectComposioApp,
  openComposioPage,
  readComposioApp,
  useComposioBot
} from '../composio/composio-client'
import { ComposioSignInWait } from '../composio/ComposioSignInWait'
import { askBotInChat } from '../webhooks/ask-bot-in-chat'
import { webhookSetUpDraft } from '../webhooks/use-webhooks-connector'
import {
  BOT_APP_CATEGORIES,
  DIRECT_APPS,
  botAppCategoryName,
  directAppLine,
  matchesAppQuery,
  type BotAppCategory,
  type BotDirectApp
} from './bot-app-catalog'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotAppCategoryIcon } from './BotAppCategoryIcon'
import { BotAppCaption } from './BotAppRow'
import { BotAppStepHeader } from './BotAppStepParts'
import { ComposioAccountStep, WebhooksStep } from './BotAppSteps'
import { CustomAppStep } from './BotAppUrlStep'
import {
  ComposioCatalogList,
  ComposioSearchGroup,
  ComposioSection,
  composioSignedIn,
  type ComposioActions,
  type ComposioPick
} from './BotAppComposio'
import {
  BotAppsRail,
  BotAppsRailMenu,
  type BotAppsRailProps,
  type BotAppsView
} from './BotAppsRail'
import { botMcpAppUrlTag } from '../../../../../shared/bots/bot-mcp-apps'
import { BotAppsMineList, BotAppsNoMatch, DirectAppRow, type DirectRow } from './BotAppsRows'
import { botToolApps } from './bot-tool-apps'
import { botMcpAppLine } from '../../../../../shared/bots/bot-app-lines'

/** Where Add leads when it isn't Orca's own connector setup, which opens in its own dialog. */
export type BotAppsStep =
  | { kind: 'webhooks' }
  | { kind: 'mcp'; app: Extract<BotDirectApp, { route: 'mcp' }> }
  | { kind: 'custom' }
  | { kind: 'composio-account'; app?: ComposioPick }
  | { kind: 'composio-wait'; app: ComposioPick; attempt: number; error: string | null }

/** Mounted only while the dialog shows, so each opening starts on All apps with an empty search. */
export function BotAppsCatalog({
  bot,
  onOpenChange,
  onManage,
  onAdd,
  step,
  setStep
}: {
  bot: Bot
  onOpenChange: (open: boolean) => void
  /** Closes the dialog for the bot's Connectors tab, where every app it has is a row. */
  onManage: () => void
  onAdd: (connector: BotConnector['id']) => void
  step: BotAppsStep | null
  setStep: (step: BotAppsStep | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = useBotConnectorState(bot)
  const composio = useComposioBot(bot)
  const [view, setView] = useState<BotAppsView>('all')
  const [query, setQuery] = useState('')
  // Let the dialog and its search field paint before mounting the catalog rows.
  const showApps = useDeferredValue(true, false)
  const searchRef = useRef<HTMLInputElement>(null)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const manage = onManage
  const webhooks = state.catalog.find((connector) => connector.id === 'webhooks')
  // Which apps the bot has, from its tools alone: no check starts its servers.
  const toolApps = botToolApps(useBotTools(bot, 'none').view)
  // A connector shows once it can be added, or once the bot has it; an MCP app always.
  const direct: DirectRow[] = DIRECT_APPS.flatMap((app): DirectRow[] => {
    if (app.route === 'mcp') {
      const tool = toolApps.find((entry) => entry.app?.id === app.id)?.tool
      const tag = tool && botMcpAppUrlTag(app, tool.detail)
      return [{ app, name: app.name, added: tool !== undefined, tag: tag ?? undefined }]
    }
    const connector = state.catalog.find((entry) => entry.id === app.connector)
    if (!connector) {
      return []
    }
    const added = state.added(connector)
    return added || state.available(connector)
      ? [{ app, connector, name: connector.label, added }]
      : []
  })
  const signedIn = composioSignedIn(composio)
  const mineDirect = direct.filter((row) => row.added)
  const byUrl = toolApps.filter((entry) => entry.app === null)
  const webhooksAdded = webhooks !== undefined && state.added(webhooks)
  const mineCount = mineDirect.length + byUrl.length + (webhooksAdded ? 1 : 0) + signedIn.size
  const categories = BOT_APP_CATEGORIES.flatMap((category) => {
    const count = direct.filter((row) => row.app.category === category).length
    return count > 0 ? [{ category, count }] : []
  })

  const connectComposio = (app: ComposioPick, attempt: number): void => {
    setStep({ kind: 'composio-wait', app, attempt, error: null })
    void connectComposioApp(bot, app.slug).catch((error: unknown) =>
      setStep({ kind: 'composio-wait', app, attempt, error: botToolErrorMessage(error) })
    )
  }
  // How an app signs in is the host's record of it, whichever list the row came from.
  const addComposio = async (app: ComposioPick, keyOk: boolean): Promise<void> => {
    if (!keyOk) {
      setStep({ kind: 'composio-account', app })
      return
    }
    const signIn = app.signIn ?? (await readComposioApp(bot, app.slug)).signIn
    if (signIn === 'own') {
      openComposioPage(COMPOSIO_PAGES.authConfigs)
    } else if (signIn === 'none') {
      await addComposioTool(bot)
      manage()
    } else {
      connectComposio(app, 1)
    }
  }
  const startComposio = (app: ComposioPick, keyOk: boolean): void => {
    void addComposio(app, keyOk).catch((error: unknown) => toast.error(botToolErrorMessage(error)))
  }
  const composioActions: ComposioActions = {
    add: (app) => startComposio(app, composio.status?.key === 'ok'),
    resume: (app) => setStep({ kind: 'composio-wait', app, attempt: 0, error: null }),
    manage
  }
  const browseAll = (): void => {
    setQuery('')
    if (composio.status?.key === 'ok') {
      setView('catalog')
    } else {
      setStep({ kind: 'composio-account' })
    }
  }
  const back = (): void => setStep(null)

  if (step?.kind === 'webhooks') {
    return (
      <WebhooksStep
        bot={bot}
        onBack={back}
        onClose={close}
        onSetUp={() => {
          close()
          askBotInChat(bot, webhookSetUpDraft())
        }}
      />
    )
  }
  if (step?.kind === 'mcp') {
    const { app } = step
    return (
      <CustomAppStep
        bot={bot}
        preset={{
          name: app.id,
          title: app.name,
          line: botMcpAppLine(app, t),
          url: app.url,
          variable: app.variable,
          logo: <BotAppBrandLogo app={app} size="lg" />
        }}
        onBack={back}
        onClose={close}
        onManage={manage}
      />
    )
  }
  if (step?.kind === 'custom') {
    return <CustomAppStep bot={bot} onBack={back} onClose={close} onManage={manage} />
  }
  if (step?.kind === 'composio-account') {
    const { app } = step
    return (
      <ComposioAccountStep
        bot={bot}
        appName={app?.name}
        onBack={back}
        onClose={close}
        onSaved={() => {
          if (app) {
            startComposio(app, true)
          } else {
            setStep(null)
            setView('catalog')
          }
        }}
      />
    )
  }
  if (step?.kind === 'composio-wait') {
    const { app, attempt } = step
    return (
      <>
        <BotAppStepHeader onBack={back} onClose={close} />
        <ComposioSignInWait
          key={attempt}
          bot={bot}
          app={app}
          connectError={step.error}
          onDone={manage}
          onRetry={() => connectComposio(app, attempt + 1)}
          onClose={close}
        />
      </>
    )
  }

  const directRow = (row: DirectRow): React.JSX.Element => (
    <DirectAppRow
      key={row.name}
      bot={bot}
      row={row}
      onAdd={(picked) =>
        'connector' in picked
          ? onAdd(picked.connector.id)
          : setStep({ kind: 'mcp', app: picked.app })
      }
      onAnother={onAdd}
      onManage={manage}
    />
  )
  const composioMine = [...signedIn].map(([slug, label]) => ({
    slug,
    name: composioAppName(
      slug,
      composio.connections?.connections.find((entry) => entry.app === slug)?.name
    ),
    line: label ?? ''
  }))
  const searching = query.trim() !== ''
  const searchAll = (): void => {
    setView('all')
    searchRef.current?.focus()
  }
  const noMatch = (where: 'all' | 'mine' | BotAppCategory): React.JSX.Element => (
    <BotAppsNoMatch
      where={where}
      query={query}
      botName={bot.name}
      onClear={() => {
        setQuery('')
        searchRef.current?.focus()
      }}
      onSearchAll={searchAll}
      onAddByUrl={() => setStep({ kind: 'custom' })}
    />
  )

  const renderList = (): React.ReactNode => {
    const composioSection = (alone: boolean) => (
      <ComposioSection
        view={composio}
        actions={composioActions}
        onBrowseAll={browseAll}
        alone={alone}
      />
    )
    if (view === 'catalog') {
      return (
        <ComposioCatalogList
          bot={bot}
          query={query}
          view={composio}
          actions={composioActions}
          empty={noMatch('all')}
        />
      )
    }
    if (view === 'mine') {
      return (
        <BotAppsMineList
          botName={bot.name}
          query={query}
          direct={mineDirect}
          renderDirect={directRow}
          byUrl={byUrl}
          webhooks={webhooksAdded}
          composio={composioMine}
          onManage={manage}
          empty={noMatch('mine')}
        />
      )
    }
    if (searching) {
      const hits =
        view === 'composio'
          ? []
          : direct.filter(
              (row) =>
                (view === 'all' || row.app.category === view) &&
                matchesAppQuery(query, row.name, directAppLine(row.app))
            )
      const where = view === 'all' || view === 'composio' ? 'all' : view
      const composioGroup = (
        <ComposioSearchGroup
          bot={bot}
          query={query}
          view={composio}
          actions={composioActions}
          divided={hits.length > 0}
          empty={noMatch(where)}
        />
      )
      return (
        <>
          {hits.length > 0 ? (
            <section aria-label={t('bots.apps.appsCaption', 'Apps')}>
              <BotAppCaption title={t('bots.apps.appsCaption', 'Apps')} count={hits.length} />
              <ul className="flex flex-col">{hits.map(directRow)}</ul>
            </section>
          ) : null}
          {composioGroup}
        </>
      )
    }
    if (view === 'composio') {
      return composioSection(true)
    }
    const shown = view === 'all' ? categories : categories.filter((c) => c.category === view)
    return (
      <>
        {shown.map(({ category }) => (
          <section key={category} aria-label={botAppCategoryName(category)}>
            <BotAppCaption
              icon={<BotAppCategoryIcon category={category} />}
              title={botAppCategoryName(category)}
            />
            <ul className="flex flex-col">
              {direct.filter((row) => row.app.category === category).map(directRow)}
            </ul>
          </section>
        ))}
        {view === 'all' ? composioSection(shown.length === 0) : null}
      </>
    )
  }

  const railProps: BotAppsRailProps = {
    bot,
    view,
    onView: (next) => {
      setView(next)
      setQuery('')
    },
    mineCount,
    categories,
    composio: true,
    onAddByUrl: () => setStep({ kind: 'custom' }),
    onWebhooks: webhooks && state.available(webhooks) ? () => setStep({ kind: 'webhooks' }) : null
  }
  const searchLabel =
    view === 'catalog'
      ? t('bots.apps.searchComposio', 'Search Composio apps')
      : view === 'mine'
        ? t('bots.apps.searchMine', 'Search On {{bot}}', { bot: bot.name })
        : t('bots.apps.search', 'Search apps')
  return (
    <div className="flex min-h-0 flex-1">
      <BotAppsRail {...railProps} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mx-4 mt-3 flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              autoFocus
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
              inset="leadingIcon"
              className="h-8"
            />
          </div>
          <BotAppsRailMenu {...railProps} />
        </div>
        <div
          aria-busy={!showApps}
          className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-3 pt-0.5 pb-3.5"
        >
          {showApps ? renderList() : null}
        </div>
      </div>
    </div>
  )
}
