import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureAutomation,
  fixtureCos,
  fixtureWorker,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import { stubSessionPrompts } from '../../component-fixtures/session-prompt-stubs'
import { stubAwaitedQuestion } from '../../component-fixtures/awaited-question-stubs'
import type { BotActivity, BotWorkerRow } from '../../../../shared/bots/bot-activity-model'
import type { BotItem } from '../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'
import type { BotConnectorEntry } from './bot-connector-entries'
import { BotNeedsYouSection } from './BotNeedsYouSection'
import type { BotNeedView } from './use-bot-now'

const now = Date.now()
const min = 60_000

function approval(id: string, title: string, tool?: [string, string]): BotWorkerRow {
  return {
    ...fixtureWorker(id, title, 'permission'),
    ...(tool ? { tool: { name: tool[0], input: tool[1] } } : {})
  }
}

function needsYou(number: number, title: string, question: string, age: number): BotItem {
  return makeTestBotItem(number, {
    title,
    status: 'needs_you',
    question: { eventId: `e${number}`, text: question },
    lastActivityAt: now - age * min
  })
}

function working(number: number, title: string, dispatch?: string): BotItem {
  return makeTestBotItem(number, {
    title,
    status: 'working',
    lastActivityAt: now - 20 * min,
    links: dispatch
      ? [
          {
            kind: 'dispatch',
            ref: dispatch,
            latest: null,
            title: 'Worker',
            state: 'working',
            host: null,
            startedAt: now - 20 * min,
            settledAt: null,
            report: null,
            pr: null
          }
        ]
      : []
  })
}

const PAIRED = needsYou(
  1,
  'Paired server: connector sign-in opens on the server, not the client',
  'Two calls: (a) OK to build fix 1 (server bots’ sign-in pages always render on the client)…',
  16 * 60
)
const WAKE_ROOT = needsYou(
  2,
  'Wake the item’s chat when a linked PR merges or closes',
  'Root cause of item 18 staying open: nothing tells a bot when a linked PR merges…',
  18 * 60
)
const RENAME = {
  ...needsYou(3, 'Rename Look around in settings copy', 'Explore or Look for work?', 24 * 60),
  othersLastEventId: 'e9'
}
const IN_PROGRESS = [
  working(10, 'Reply chips for Slack threads'),
  working(11, 'Phone tidy-up sheet loses scroll on rotate'),
  working(12, 'Wake the item’s chat when a linked PR merges or closes', 'd-wake')
]

const NOTE = approval('d-note', 'Unanswered-question note every 5 turns', [
  'Bash',
  'pnpm vitest run src/shared/bots'
])

function activity(workers: BotWorkerRow[]): BotActivity {
  return {
    workers,
    inProgress: [],
    completed: [],
    automations: [fixtureAutomation('a-digest', 'Morning digest', 'FREQ=DAILY;BYHOUR=9')],
    waits: []
  }
}

function panel({
  width = 340,
  workers,
  items,
  homeAsks = false,
  focusFirst = false
}: {
  width?: number
  workers: BotWorkerRow[]
  items?: BotItem[]
  /** The Home chat asks the owner a question. */
  homeAsks?: boolean
  /** Tab onto the first row, as the keyboard lands there. */
  focusFirst?: boolean
}) {
  return defineFixture({
    width,
    store: botPanelPage(true, homeAsks ? 'waiting' : null),
    setup: () => {
      stubBotPanel(activity(workers), fixtureCos, [], items)()
      void stubSessionPrompts(
        homeAsks
          ? {
              'chat-cos': {
                kind: 'question',
                question: 'Ship the tidy-up line change today, or wait for Carol’s review?'
              }
            }
          : {}
      )
    },
    render: () => <BotPanelFrame />,
    interact: focusFirst
      ? async (frame) => {
          const row = await waitFor(() =>
            frame.querySelector<HTMLButtonElement>('[data-need-key] button[aria-label]')
          )
          // Chromium's focusVisible option draws the keyboard ring for a scripted focus.
          const options: FocusOptions & { focusVisible: boolean } = { focusVisible: true }
          row.focus(options)
        }
      : undefined
  })
}

async function waitFor<T>(found: () => T | null | undefined | false): Promise<T> {
  for (let tries = 0; tries < 50; tries++) {
    const result = found()
    if (result) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Needs you fixture did not reach the expected state')
}

/** One worker approval and two items: one Needs you group, approval first, counted 3 everywhere. */
export const proposed = panel({ workers: [NOTE], items: [PAIRED, WAKE_ROOT, ...IN_PROGRESS] })

/** Approval, the Home chat's question, then items in their own order. */
export const mixed = panel({
  workers: [NOTE],
  items: [RENAME, PAIRED, WAKE_ROOT, ...IN_PROGRESS],
  homeAsks: true
})

/** Two workers on one item ask apart, each under the item's title with its own name. */
export const itemWorkers = panel({
  workers: [
    { ...approval('d-wake', 'Webhook wake-up', ['Bash', 'git push origin wake-item-chat']) },
    { ...approval('d-wake-2', 'Wake-up tests'), dispatchId: 'd-wake' }
  ],
  items: [PAIRED, ...IN_PROGRESS]
})

/** Eight needs: five rows, then Show 3 more. */
export const capped = panel({
  workers: [
    NOTE,
    approval('d-a', 'Release notes: changelog pass', ['Write', 'docs/release-notes/1.4.223.md']),
    approval('d-b', 'Codex in scratch folder')
  ],
  items: [RENAME, PAIRED, WAKE_ROOT, needsYou(4, 'Pick a release headline', 'A or B?', 120)],
  homeAsks: true
})

/** The keyboard on the first row: the body's ring, Open shown and named. */
export const focused = panel({ workers: [NOTE], items: [PAIRED, WAKE_ROOT], focusFirst: true })

/** The sidebar at its narrowest: item ages hide, asks never had one. */
export const narrow = panel({
  width: 260,
  workers: [NOTE],
  items: [PAIRED, WAKE_ROOT],
  homeAsks: true
})

/** No items yet: the empty line shrinks under the ask. */
export const noItems = panel({ workers: [NOTE], items: [] })

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Needs you reads only these fields.
const GITHUB = {
  kind: 'github',
  key: 'github:w1',
  title: { service: 'GitHub', name: null },
  needsOwner: true
} as BotConnectorEntry
const SIGN_IN: BotNeedView[] = [
  { kind: 'connector', key: 'connector:github:w1', connector: GITHUB }
]
const STOPPED = ['Nightly PR sweep', 'Morning digest'].map((name, index) => ({
  ...fixtureAutomation(`a-${index}`, name, 'FREQ=DAILY;BYHOUR=9'),
  needsSignIn: true,
  latestRunId: `r${index}`
}))

/** A sign-in with the two runs it stopped: listed as context after it, never counted. */
export const signIn = defineFixture({
  width: 340,
  render: () => (
    <div className="@container flex flex-col bg-sidebar px-2 py-3">
      <BotNeedsYouSection
        bot={fixtureCos}
        asks={{ needs: SIGN_IN, stoppedForSignIn: STOPPED, itemOf: () => null }}
      />
    </div>
  )
})

const REVIEW_THREAD: BotNeedView = {
  kind: 'session',
  key: 'thread:t-review',
  row: {
    kind: 'thread',
    key: 'thread:t-review',
    title: 'Link-open default review',
    source: 'slack',
    dot: 'waiting',
    sessionId: 't-review',
    at: now - 40 * min
  }
}

/** A chat waiting on a question it asked without stopping: the row says the question, with Skip. */
export const olderQuestion = defineFixture({
  width: 340,
  setup: () =>
    stubAwaitedQuestion(
      't-review',
      'ask-row',
      'Should links from chat open in the app by default, or in your browser?'
    ),
  render: () => (
    <div className="@container flex flex-col bg-sidebar px-2 py-3">
      <BotNeedsYouSection
        bot={fixtureCos}
        asks={{ needs: [REVIEW_THREAD], stoppedForSignIn: [], itemOf: () => null }}
      />
    </div>
  ),
  interact: async (frame) => {
    const row = await waitFor(() =>
      frame.querySelector<HTMLButtonElement>('[data-need-key] button[aria-label]')
    )
    const options: FocusOptions & { focusVisible: boolean } = { focusVisible: true }
    row.focus(options)
  }
})
