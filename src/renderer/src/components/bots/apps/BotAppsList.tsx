// Add apps' list for the view the chips (or "N added") picked, or for a search.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { ComposioBotView } from '../composio/composio-client'
import {
  BOT_APP_CATEGORIES,
  botAppCategoryName,
  directAppLine,
  matchesAppQuery,
  type BotAppCategory
} from './bot-app-catalog'
import { BotAppCaption, BotAppGrid } from './BotAppRow'
import {
  ComposioCatalogList,
  ComposioSearchGroup,
  ComposioSection,
  type ComposioActions
} from './BotAppComposio'
import { BotAppsAddedList, type BotAddedSources } from './BotAppsAdded'
import type { BotAppsView } from './BotAppsChips'
import { CustomAppRow, type CustomApp, type DirectRow } from './BotAppsRows'

export function BotAppsList({
  bot,
  view,
  query,
  direct,
  renderDirect,
  custom,
  onCustom,
  added,
  onManage,
  composio,
  composioActions,
  onBrowseAll,
  noMatch
}: {
  bot: Bot
  view: BotAppsView
  query: string
  /** Every app with a direct route the bot can be given, in DIRECT_APPS order. */
  direct: readonly DirectRow[]
  renderDirect: (row: DirectRow) => React.JSX.Element
  custom: readonly CustomApp[]
  onCustom: (id: CustomApp['id']) => void
  added: BotAddedSources
  onManage: () => void
  composio: ComposioBotView
  composioActions: ComposioActions
  onBrowseAll: () => void
  noMatch: (where: 'all' | 'mine' | BotAppCategory) => React.JSX.Element
}): React.JSX.Element {
  const t = useTranslate()
  const customRow = (app: CustomApp): React.JSX.Element => (
    <CustomAppRow key={app.id} app={app} onOpen={onCustom} onManage={onManage} />
  )
  const customTitle = t('bots.apps.custom.name', 'Custom')
  const appsTitle = t('bots.apps.appsCaption', 'Apps')

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
      <BotAppsAddedList
        sources={added}
        query={query}
        renderDirect={renderDirect}
        onManage={onManage}
        empty={noMatch('mine')}
      />
    )
  }
  if (query.trim() !== '') {
    const hits =
      view === 'composio' || view === 'custom'
        ? []
        : direct.filter(
            (row) =>
              (view === 'all' || row.app.category === view) &&
              matchesAppQuery(query, row.name, directAppLine(row.app))
          )
    const customHits =
      view === 'all' || view === 'custom'
        ? custom.filter((app) => matchesAppQuery(query, app.name, app.line))
        : []
    const where = view === 'all' || view === 'composio' || view === 'custom' ? 'all' : view
    const found = hits.length + customHits.length
    const composioGroup =
      view !== 'custom' ? (
        <ComposioSearchGroup
          bot={bot}
          query={query}
          view={composio}
          actions={composioActions}
          divided={found > 0}
          empty={noMatch(where)}
        />
      ) : null
    if (found === 0 && !composioGroup) {
      return noMatch(where)
    }
    return (
      <>
        {found > 0 ? (
          <section aria-label={appsTitle}>
            <BotAppCaption title={appsTitle} count={found} />
            <BotAppGrid>
              {hits.map(renderDirect)}
              {customHits.map(customRow)}
            </BotAppGrid>
          </section>
        ) : null}
        {composioGroup}
      </>
    )
  }
  const composioSection = (
    <ComposioSection
      view={composio}
      actions={composioActions}
      onBrowseAll={onBrowseAll}
      preview={view === 'all'}
    />
  )
  const customSection = (
    <section aria-label={customTitle}>
      <BotAppCaption title={customTitle} />
      <BotAppGrid>{custom.map(customRow)}</BotAppGrid>
    </section>
  )
  if (view === 'composio') {
    return composioSection
  }
  if (view === 'custom') {
    return customSection
  }
  if (view !== 'all') {
    const rows = direct.filter((row) => row.app.category === view)
    const title = botAppCategoryName(view)
    return (
      <section aria-label={title}>
        <BotAppCaption title={title} count={rows.length} />
        <BotAppGrid>{rows.map(renderDirect)}</BotAppGrid>
      </section>
    )
  }
  // One grid in category order: the chips do the grouping, so no row is left half empty.
  const ordered = BOT_APP_CATEGORIES.flatMap((category) =>
    direct.filter((row) => row.app.category === category)
  )
  return (
    <>
      {ordered.length > 0 ? (
        <section aria-label={appsTitle}>
          <BotAppCaption title={appsTitle} count={ordered.length} />
          <BotAppGrid>{ordered.map(renderDirect)}</BotAppGrid>
        </section>
      ) : null}
      {composioSection}
      {customSection}
    </>
  )
}
