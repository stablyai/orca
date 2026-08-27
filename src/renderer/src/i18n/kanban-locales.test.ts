import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const localizedCatalogs = { es, ja, ko, zh }

// Why: the Kanban task source ships a whole surface at once, so coverage is
// grouped by the flow the user walks instead of one flat list.
const kanbanKeyGroups = {
  sourceLabel: ['auto.components.TaskPage.kanbanSourceLabel'],
  connection: [
    'auto.components.kanban.connect.title',
    'auto.components.kanban.connect.description',
    'auto.components.kanban.connect.action',
    'auto.components.kanban.connect.hide',
    'auto.components.kanban.connect.dialog.title',
    'auto.components.kanban.connect.dialog.description',
    'auto.components.kanban.connect.dialog.server',
    'auto.components.kanban.connect.dialog.token',
    'auto.components.kanban.connect.dialog.tokenPlaceholder',
    'auto.components.kanban.connect.dialog.storage',
    'auto.components.kanban.connect.dialog.cancel',
    'auto.components.kanban.connect.dialog.connect',
    'auto.components.kanban.connect.dialog.verifying'
  ],
  filters: [
    'auto.components.kanban.filter.executor',
    'auto.components.kanban.filter.observer',
    'auto.components.kanban.filter.creator',
    'auto.components.kanban.filter.search',
    'auto.components.kanban.filter.clearSearch',
    'auto.components.kanban.filter.dueAny',
    'auto.components.kanban.filter.dueToday',
    'auto.components.kanban.filter.dueWeek',
    'auto.components.kanban.filter.dueOverdue',
    'auto.components.kanban.filter.dueNone',
    'auto.components.kanban.filter.urgent',
    'auto.components.kanban.filter.includeDone',
    'auto.components.kanban.filter.allLanes',
    'auto.components.kanban.filter.refresh'
  ],
  listStates: [
    'auto.components.kanban.list.name',
    'auto.components.kanban.list.empty',
    'auto.components.kanban.list.emptyHint',
    'auto.components.kanban.list.rowLabel',
    'auto.components.kanban.list.urgent'
  ],
  errors: [
    'auto.components.kanban.error.auth',
    'auto.components.kanban.error.reconnect',
    'auto.components.kanban.error.retry',
    'auto.components.kanban.detail.error',
    'auto.components.kanban.detail.notFound'
  ],
  detail: [
    'auto.components.kanban.detail.description',
    'auto.components.kanban.detail.result',
    'auto.components.kanban.detail.roles',
    'auto.components.kanban.detail.executors',
    'auto.components.kanban.detail.observers',
    'auto.components.kanban.detail.createdBy',
    'auto.components.kanban.detail.comments',
    'auto.components.kanban.detail.dependencies',
    'auto.components.kanban.detail.repositories',
    'auto.components.kanban.detail.attachments',
    'auto.components.kanban.detail.attachmentSize',
    'auto.components.kanban.detail.close',
    'auto.components.kanban.detail.backToList',
    'auto.components.kanban.detail.openBrowser',
    'auto.components.kanban.detail.openBrowserLabel'
  ],
  // An ambiguous project match has no Kanban string of its own: Start opens the
  // standard composer with nothing preselected, so the composer's own project
  // picker copy is what the user reads.
  start: [
    'auto.components.kanban.list.start',
    'auto.components.kanban.list.startTooltip',
    'auto.components.kanban.list.openBrowser',
    'auto.components.kanban.workspaceOpenFailed',
    'auto.components.NewWorkspaceComposerCard.dccd26d4e4'
  ],
  boardUpdate: [
    'auto.components.kanban.sync.failed',
    'auto.components.kanban.sync.networkError',
    'auto.components.kanban.sync.retry'
  ],
  settings: [
    'auto.components.settings.TasksPane.kanbanLabel',
    'auto.components.settings.TasksPane.kanbanDescription',
    'auto.components.settings.integrations.search.kanbanTitle',
    'auto.components.settings.integrations.search.kanbanDescription',
    'auto.components.settings.kanban.integration.card.statusConnected',
    'auto.components.settings.kanban.integration.card.statusNotConnected',
    'auto.components.settings.kanban.integration.card.connectedDescription',
    'auto.components.settings.kanban.integration.card.notConnectedDescription',
    'auto.components.settings.kanban.integration.card.checkingDescription',
    'auto.components.settings.kanban.integration.card.credentialCopy',
    'auto.components.settings.kanban.integration.card.tokenNote',
    'auto.components.settings.kanban.integration.card.connect',
    'auto.components.settings.kanban.integration.card.updateToken',
    'auto.components.settings.kanban.integration.card.recheck',
    'auto.components.settings.kanban.integration.card.disconnect',
    'auto.components.settings.kanban.integration.card.disconnectLabel'
  ]
} as const

const kanbanKeys = Object.values(kanbanKeyGroups).flat()

// The board vocabulary is fixed Russian by design (the retry affordance mirrors
// the card the user sees) and the bare product name stays Latin, so neither can
// be expected to differ per locale.
const localeInvariantKeys = new Set<string>([
  'auto.components.TaskPage.kanbanSourceLabel',
  'auto.components.settings.TasksPane.kanbanLabel',
  'auto.components.kanban.sync.failed',
  'auto.components.kanban.sync.retry'
])

function catalogValue(catalog: object, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    return (value as Record<string, unknown>)[part]
  }, catalog)
}

function missingKeys(catalog: object): string[] {
  return kanbanKeys.filter((key) => {
    const value = catalogValue(catalog, key)
    return typeof value !== 'string' || value.trim() === ''
  })
}

describe('Kanban task source locale coverage', () => {
  it('declares every Kanban surface string in en.json', () => {
    expect(missingKeys(en)).toEqual([])
  })

  it.each(Object.entries(localizedCatalogs))('%s carries every Kanban key', (_locale, catalog) => {
    expect(missingKeys(catalog)).toEqual([])
  })

  it.each(Object.entries(localizedCatalogs))('%s translates Kanban copy', (_locale, catalog) => {
    const untranslated = kanbanKeys.filter(
      (key) => !localeInvariantKeys.has(key) && catalogValue(catalog, key) === catalogValue(en, key)
    )
    expect(untranslated).toEqual([])
  })
})
