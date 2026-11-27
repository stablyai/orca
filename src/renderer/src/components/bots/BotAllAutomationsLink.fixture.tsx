// A bot's "All N automations" next to the Automations list it opens: the real link, store action,
// request hook, filter and pills; the page shell around the list is left out.
import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureAutomation as automation,
  fixtureCos,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { makeAutomation, makeAutomationListRow } from '../automations/automations-page-fixtures'
import {
  AutomationListFilterMenu,
  AutomationListFilterPills
} from '../automations/listing/AutomationListFilterMenu'
import {
  botListFilter,
  isAutomationListFilterActive,
  type AutomationListFilter
} from '../automations/listing/automation-list-view'
import {
  offersAutomationTemplates,
  resolveAutomationListEmptyState
} from '../automations/listing/automation-list-empty-state'
import { AutomationListEmptyView } from '../automations/listing/AutomationListEmptyView'
import { useAutomationListSearch } from '../automations/listing/use-automation-list-search'
import { automationListBotHost } from '../automations/listing/automation-list-bot-host'
import { AutomationTemplateEmptyState } from '../automations/authoring/AutomationTemplateEmptyState'
import type { AutomationHostFilterResolution } from '../automations/hosts/automation-host-filter-resolution'
import { useAutomationsPageBotFilterRequest } from '../automations/use-automations-page-bot-filter-request'

const hour = 3_600_000
const now = Date.now()
const home = folderWorkspaceKey(fixtureCos.folderWorkspaceId)
const NAMES = [
  'Morning digest',
  'Triage new issues',
  'Weekly changelog',
  'Review stale branches',
  'Nightly cleanup',
  'Release notes draft'
]
const automations: BotAutomationRow[] = [
  ...NAMES.map((name, index) =>
    automation(`a-${index}`, name, 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', {
      nextRunAt: now + (index + 1) * hour
    })
  ),
  automation('a-paused', 'Monthly report', 'FREQ=MONTHLY', { enabled: false })
]
const wait = (id: string, name: string): BotAutomationRow => ({
  ...automation(id, name, ''),
  automation: { ...automation(id, name, '').automation, once: { by: now + 5 * hour } }
})
const ACTIVITY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations,
  waits: [wait('w-1', 'Wait for build to finish'), wait('w-2', 'Wait for review')]
}
// What the hosts answer: this bot's automations and one of its waits (never listed), another bot's, and
// a paired server that happens to reuse this bot's workspace key (not this bot's).
const PAGE_ROWS = [
  makeAutomationListRow({
    automation: makeAutomation({
      id: 'w-1',
      name: 'Wait for build to finish',
      workspaceId: home,
      once: { by: now + 5 * hour }
    })
  }),
  makeAutomationListRow({
    automation: makeAutomation({ id: 'srv-1', name: 'Server: nightly backup', workspaceId: home }),
    catalogRef: {
      authority: { kind: 'runtime', environmentId: 'env-server' },
      selector: { kind: 'self' }
    },
    hostLabel: 'Build server'
  }),
  ...automations.map(({ automation: facts }) =>
    makeAutomationListRow({
      automation: makeAutomation({
        id: facts.id,
        name: facts.name,
        enabled: facts.enabled,
        workspaceId: home
      })
    })
  ),
  ...['Other bot: inbox sweep', 'Other bot: standup notes', 'Repo: dependency audit'].map(
    (name, index) =>
      makeAutomationListRow({
        automation: makeAutomation({
          id: `other-${index}`,
          name,
          workspaceId: index < 2 ? 'folder:other-bot' : null
        })
      })
  )
]

const NO_REPOS = new Map()
const ALL_HOSTS_READY: AutomationHostFilterResolution = {
  effective: { kind: 'all' },
  entry: null,
  status: 'ready',
  announceFallback: false
}

function AutomationsListHarness({ pageRows }: { pageRows: typeof PAGE_ROWS }): React.JSX.Element {
  const [listFilter, setListFilter] = useState<AutomationListFilter>(() =>
    botListFilter(useAppStore.getState().automationsPageBotFilterRequest)
  )
  const [listSearchQuery, setListSearchQuery] = useState('')
  useAutomationsPageBotFilterRequest({
    local: { setListFilter, setListSearchQuery },
    navigation: { showList: () => {} },
    selectHost: () => {}
  })
  // The page's own counting, empty-state resolver, empty view and templates.
  const { filteredRows, hasListItems, searchCounts } = useAutomationListSearch({
    listSearchQuery,
    listFilter,
    botHost: listFilter.bot ? automationListBotHost(listFilter.bot.hostId, null) : null,
    rows: pageRows,
    externalAutomationEntries: [],
    repoMap: NO_REPOS,
    selectedRowKey: null,
    selectedExternalKey: null,
    selectAutomationRow: () => {},
    selectExternalKey: () => {}
  })
  const emptyStateInput = {
    resolution: ALL_HOSTS_READY,
    ...searchCounts,
    filterActive: isAutomationListFilterActive(listFilter)
  }
  const emptyState = resolveAutomationListEmptyState(emptyStateInput)
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 p-4" data-testid="automations-list">
      <div className="flex items-center gap-2">
        <AutomationListFilterMenu filter={listFilter} onChange={setListFilter} />
        <span className="text-xs text-muted-foreground">{filteredRows.length} listed</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <AutomationListFilterPills filter={listFilter} onChange={setListFilter} />
      </div>
      {filteredRows.length === 0 ? (
        <AutomationListEmptyView {...emptyStateInput} />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border text-sm">
          {filteredRows.map((row) => (
            <li key={row.key} className="flex justify-between px-3 py-1.5">
              <span>{row.automation.name}</span>
              <span className="text-xs text-muted-foreground">
                {row.automation.enabled ? 'Enabled' : 'Paused'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {offersAutomationTemplates(emptyState, hasListItems) ? (
        <AutomationTemplateEmptyState onOpenCreate={() => {}} />
      ) : null}
    </div>
  )
}

function Frame({
  listWidth,
  pageRows = PAGE_ROWS
}: {
  listWidth?: number
  pageRows?: typeof PAGE_ROWS
}): React.JSX.Element {
  return (
    <div className="flex">
      <div className="w-[340px] shrink-0">
        <BotPanelFrame />
      </div>
      <div className="flex" style={listWidth ? { width: listWidth } : { flex: 1 }}>
        <AutomationsListHarness pageRows={pageRows} />
      </div>
    </div>
  )
}

async function waitFor<T>(find: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = find()
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('fixture: element never appeared')
}

const allLink = (frame: HTMLElement): Promise<HTMLButtonElement> =>
  waitFor(() =>
    [...frame.querySelectorAll('button')].find((button) => button.textContent?.startsWith('All '))
  )
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

const longNamed: Bot = { ...fixtureCos, name: 'Release coordination and on-call helper' }

export const beforeClick = defineFixture({
  width: 980,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY),
  render: () => <Frame />,
  interact: async (frame) => {
    await allLink(frame)
  }
})

export const afterClick = defineFixture({
  width: 980,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY),
  render: () => <Frame />,
  interact: async (frame) => {
    ;(await allLink(frame)).click()
    await settle()
  }
})

export const afterClear = defineFixture({
  width: 980,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY),
  render: () => <Frame />,
  interact: async (frame) => {
    ;(await allLink(frame)).click()
    const remove = await waitFor(() =>
      frame.querySelector<HTMLButtonElement>('button[aria-label^="Remove Bot filter"]')
    )
    remove.click()
    await settle()
  }
})

export const narrowLongName = defineFixture({
  width: 640,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY, longNamed),
  render: () => <Frame listWidth={300} />,
  interact: async (frame) => {
    ;(await allLink(frame)).click()
    await settle()
  }
})

// The bot's host is not listed yet, so none of its automations are on the page; others are.
export const noMatches = defineFixture({
  width: 980,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY),
  render: () => <Frame pageRows={PAGE_ROWS.filter((row) => row.automation.workspaceId !== home)} />,
  interact: async (frame) => {
    ;(await allLink(frame)).click()
    await settle()
  }
})

// The Filters menu lists the Bot filter its badge counts.
async function openFiltersMenu(frame: HTMLElement): Promise<void> {
  ;(await allLink(frame)).click()
  await settle()
  const trigger = [...frame.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Filters')
  )
  trigger?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: 'mouse'
    })
  )
  await settle()
}

export const filtersMenu = defineFixture({
  width: 980,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY),
  render: () => <Frame />,
  interact: openFiltersMenu
})

export const filtersMenuLongName = defineFixture({
  width: 980,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY, longNamed),
  render: () => <Frame />,
  interact: openFiltersMenu
})
