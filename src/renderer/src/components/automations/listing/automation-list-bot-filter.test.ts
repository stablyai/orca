// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { StableAutomationCatalogRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { hostStableKey } from '../../../../../shared/automations/ownership/automation-owner-key'
import type { Bot } from '../../../../../shared/bot-types'
import { buildBotActivity } from '../../../../../shared/bots/bot-activity-model'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import {
  AUTOMATION_CARD_CAP,
  botAutomationCardRows,
  botAutomationCardView
} from '../../bots/bot-automation-card'
import { makeAutomation } from '../automations-page-fixtures'
import type { AutomationHostCacheEntry } from '../hosts/automation-host-cache-types'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from '../hosts/automation-host-catalog-types'
import { resolveAutomationHostListRows } from '../hosts/automation-host-list-rows'
import { automationListBotHost } from './automation-list-bot-host'
import { botListFilter } from './automation-list-view'
import { useAutomationListSearch } from './use-automation-list-search'

const bot: Bot = {
  id: 'bot-1',
  name: 'Fixture Bot',
  hostId: 'local',
  folder: 'fixture-bot',
  folderWorkspaceId: 'fixture-bot-home',
  agent: 'opencode',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const home = folderWorkspaceKey(bot.folderWorkspaceId)

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  return makeAutomation({ id, name: `Fixture ${id}`, workspaceId: home, ...overrides })
}

const desktop: StableAutomationCatalogRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}
const server: StableAutomationCatalogRef = {
  authority: { kind: 'runtime', environmentId: 'env-server' },
  selector: { kind: 'self' }
}

// This computer: the bot's seven automations (one paused) and two waits, another workspace's, and one
// with no workspace. A paired server: an automation in a workspace with the same key.
const desktopAutomations: Automation[] = [
  ...Array.from({ length: 6 }, (_, index) =>
    automation(`auto-${index}`, { nextRunAt: index + 10 })
  ),
  automation('auto-paused', { enabled: false }),
  automation('wait-1', { once: { by: 50 } }),
  automation('wait-2', { once: {} }),
  automation('other', { workspaceId: 'folder:other-home' }),
  automation('unplaced', { workspaceId: null })
]
const serverAutomations: Automation[] = [automation('server-same-key')]

function catalogEntry(ref: StableAutomationCatalogRef): AutomationHostCatalogEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row builder reads only these fields.
  return {
    stableRef: ref,
    stableKey: hostStableKey(ref),
    label: hostStableKey(ref),
    authorityLabel: hostStableKey(ref)
  } as AutomationHostCatalogEntry
}

/** Both hosts' raw answers through the page's own catalog row builder, as All hosts shows them. */
function catalogRows() {
  const entries = [catalogEntry(desktop), catalogEntry(server)]
  const answers = new Map([
    [entries[0].stableKey, desktopAutomations],
    [entries[1].stableKey, serverAutomations]
  ])
  return resolveAutomationHostListRows({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row builder reads only entries.
    catalog: { entries } as unknown as AutomationHostCatalog,
    resolution: {
      effective: { kind: 'all' },
      entry: null,
      status: 'ready',
      announceFallback: false
    },
    entry: (stableKey) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row builder reads only data and fetchedAt.
      ({
        fetchedAt: 1,
        data: (answers.get(stableKey) ?? []).map((entry) => ({
          automation: entry,
          owner: null,
          selector: { kind: 'self' },
          usageSummary: null
        }))
      }) as unknown as AutomationHostCacheEntry
  }).rows
}

describe("a bot's All N automations", () => {
  it('opens a list that shows exactly the N automations it counts', () => {
    // As this computer's host reads Activity: the automations that run in the bot's home.
    const activity = buildBotActivity({
      bot,
      sessions: [],
      links: [],
      workers: [],
      automations: desktopAutomations.filter((entry) => entry.workspaceId === home),
      runs: [],
      sessionStatus: () => null
    })
    const card = botAutomationCardRows(bot, activity, 0)
    const view = botAutomationCardView(card)

    // As the Automations page lists them, from every host's raw rows, waits included.
    const filter = botListFilter({ workspaceId: home, name: bot.name, hostId: bot.hostId })
    const { result } = renderHook(() =>
      useAutomationListSearch({
        listSearchQuery: '',
        listFilter: filter,
        botHost: automationListBotHost(bot.hostId, null),
        rows: catalogRows(),
        externalAutomationEntries: [],
        repoMap: new Map(),
        selectedRowKey: null,
        selectedExternalKey: null,
        selectAutomationRow: () => {},
        selectExternalKey: () => {}
      })
    )
    const listedIds = result.current.filteredRows.map((row) => row.automation.id).sort()
    const cardIds = card.flatMap((row) =>
      row.kind === 'automation' ? [row.row.automation.id] : []
    )

    expect(view.listed).toBe(7)
    expect(view.listedPaused).toBe(1)
    expect(listedIds).toEqual(
      [...Array.from({ length: 6 }, (_, index) => `auto-${index}`), 'auto-paused'].sort()
    )
    expect(listedIds).toEqual(cardIds.sort())
    // Rows the card hides are ones the filtered page lists; waits it cannot list stay on the card.
    const shownKeys = new Set(view.shown.map((row) => row.key))
    const hidden = card.filter((row) => !shownKeys.has(row.key))
    expect(hidden.every((row) => row.kind === 'automation')).toBe(true)
    expect(hidden).toHaveLength(7 - AUTOMATION_CARD_CAP)
    expect(view.shown.filter((row) => row.kind === 'wait')).toHaveLength(2)
  })

  it("lists a paired server's bot from that server only, whatever this computer has", () => {
    const filter = botListFilter({
      workspaceId: home,
      name: bot.name,
      hostId: 'runtime:env-server'
    })
    const { result } = renderHook(() =>
      useAutomationListSearch({
        listSearchQuery: '',
        listFilter: filter,
        botHost: automationListBotHost('runtime:env-server', null),
        rows: catalogRows(),
        externalAutomationEntries: [],
        repoMap: new Map(),
        selectedRowKey: null,
        selectedExternalKey: null,
        selectAutomationRow: () => {},
        selectExternalKey: () => {}
      })
    )
    expect(result.current.filteredRows.map((row) => row.automation.id)).toEqual(['server-same-key'])
  })
})
