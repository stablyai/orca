import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureCos,
  fixtureWorker,
  stubBotPanel
} from '../../../component-fixtures/fixture-bot-panel'
import { RIGHT_SIDEBAR_MIN_WIDTH } from '../../right-sidebar/layout/right-sidebar-width'
import type { BotActivity, BotWorkerRow } from '../../../../../shared/bots/bot-activity-model'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

const now = Date.now()
const min = 60_000

const activity = (workers: BotWorkerRow[] = []): BotActivity => ({
  workers,
  inProgress: [],
  completed: [],
  automations: [],
  waits: [],
  upNext: { state: { running: false, seenAt: 0 }, items: [] }
})

const ITEMS = [
  makeTestBotItem(128, {
    title: 'Pick the release headline',
    status: 'needs_you',
    lastActivityAt: now - 4 * min
  }),
  makeTestBotItem(131, {
    title: 'Fix flaky relay reconnect test',
    status: 'working',
    lastActivityAt: now - 9 * min
  }),
  makeTestBotItem(127, {
    title: 'Draft release notes for 1.4.240',
    status: 'working',
    lastActivityAt: now - 26 * min
  }),
  makeTestBotItem(125, {
    title: 'Clean up stale worktrees',
    status: 'working',
    lastActivityAt: now - 2 * 60 * min
  }),
  makeTestBotItem(119, {
    title: 'Triage the Linear inbox',
    status: 'working',
    lastActivityAt: now - 5 * 60 * min
  })
]

/** The panel with its item read held open, so the list stays loading. */
function stubLoading(workers?: BotWorkerRow[]): () => void {
  return () => {
    stubBotPanel(activity(workers), fixtureCos)()
    const runtime = window.api.runtime
    const call = runtime.call
    Reflect.set(window.api, 'runtime', {
      ...runtime,
      call: (request: Parameters<typeof call>[0]) =>
        request.method === 'bots.items.owner.list' ? new Promise(() => {}) : call(request)
    })
  }
}

// The skeleton shows only after 150 ms; wait past that before the shot.
const pastDelay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))

function loading(width: number, workers?: BotWorkerRow[]) {
  return defineFixture({
    width,
    store: botPanelPage(true, null),
    setup: stubLoading(workers),
    interact: pastDelay,
    render: () => <BotPanelFrame />
  })
}

function loaded(width: number) {
  return defineFixture({
    width,
    store: botPanelPage(true, null),
    setup: stubBotPanel(activity(), fixtureCos, [], ITEMS),
    interact: pastDelay,
    render: () => <BotPanelFrame />
  })
}

/** A header bar and five rows at the list's geometry while the first item read is out. */
export const loadingPanel = loading(360)
export const loadingNarrow = loading(RIGHT_SIDEBAR_MIN_WIDTH)
/** An ask already shows Needs you: the bars follow as their own group, a section's gap below. */
export const loadingWithAsk = loading(360, [
  fixtureWorker('d1', 'Fix flaky relay reconnect test', 'blocked')
])
/** The same panel once items land, for a side-by-side check that nothing moves. */
export const loadedPanel = loaded(360)
export const loadedNarrow = loaded(RIGHT_SIDEBAR_MIN_WIDTH)
