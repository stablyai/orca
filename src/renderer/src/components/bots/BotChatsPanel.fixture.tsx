import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureChat,
  fixtureCos,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'

const now = Date.now()
const min = 60_000
const bot = { ...fixtureCos, name: 'Bot builder' }

const run = (
  key: string,
  title: string,
  branch: string,
  ago: number,
  extra: Partial<BotChatTreeWorker> = {}
): BotChatTreeWorker => ({
  key,
  title,
  branch,
  state: 'running',
  startedAt: now - ago,
  dispatchId: key,
  ...extra
})
const done = (
  key: string,
  title: string,
  branch: string,
  took: number,
  extra: Partial<BotChatTreeWorker> = {}
): BotChatTreeWorker => ({
  key,
  title,
  branch,
  state: 'done',
  startedAt: now - 3_600_000 - took,
  settledAt: now - 3_600_000,
  dispatchId: key,
  ...extra
})
const chat = fixtureChat
// The bot's page with its Chats tab open.
const chatsTab = (chatState: 'working' | null) => ({
  ...botPanelPage(true, chatState),
  rightSidebarTab: 'bot-chats' as const
})

const home = chat('home', 'Home Chat', {
  origin: 'home',
  tab: true,
  lastActiveAt: now - 4 * min,
  preview: 'Filed 2 bug reports and pinged #bots about the reply fix.',
  running: [
    run('w7', 'ENG-14275 Codex hook spawn', 'alice/eng-14275-codex-hooks', min, {
      state: 'unreachable',
      hostId: 'runtime:build-box'
    }),
    run('w1', 'Phone: one Bots list across computers', 'alice/phone-one-bots-list', 26 * min),
    run('w2', 'Paired bots PR 6: relay auth', 'alice/paired-bots-relay-auth', 9 * min, {
      state: 'needs-you',
      hostId: 'runtime:build-box'
    }),
    run('w3', 'Build: agy as a bot agent', 'alice/agy-bot-agent', 12 * min, {
      state: 'asking-bot'
    }),
    run('w4', 'Fix flaky relay reconnect test', 'fix/relay-reconnect-flake', 41 * min, {
      note: 'handed-over',
      dispatchId: undefined
    }),
    run('w5', 'Morning standup digest', '', 2 * min, {
      note: 'automation-terminal',
      branch: undefined,
      run: { automationId: 'a-digest', runId: 'r1' }
    }),
    run('w6', 'Zip import parser fix', 'alice/zip-import', 7 * min, { note: 'from-closed-chat' })
  ],
  finished: [
    done('f1', 'Check ux-designer’s Slack scopes', 'alice/slack-scope-check', 8 * min),
    done(
      'f2',
      'Paired bots PR 5: connectors on server',
      'alice/paired-bots-connector-setup',
      55 * min
    )
  ],
  finishedTotal: 8
})
const slack = chat('slack', 'Why ux-designer didn’t reply', {
  origin: 'slack',
  originLabel: '#ui-ux-design',
  live: 'needs-you',
  tab: true,
  lastActiveAt: now - min,
  running: [
    run('s1', 'Fix ux-designer reply routing', 'alice/fix-reply-routing', 12 * min),
    run('s2', 'Check #ui-ux-design membership', 'alice/fix-reply-routing', 3 * min)
  ]
})
const draft = chat('draft', 'Draft the 1.4.230 release notes', {
  live: 'replying',
  lastActiveAt: now
})
const rollout = chat('rollout', 'Paired bots rollout', {
  preview: 'Six PRs in flight; 2 merged this morning.',
  running: [
    run('r7', 'PR 7: server-side bot create', 'alice/paired-bots-create', 31 * min),
    run('r8', 'PR 8: connector sign-in on server', 'alice/paired-bots-signin', 28 * min),
    run('r9', 'PR 9: bot list sync', 'alice/paired-bots-list-sync', 22 * min, {
      hostId: 'runtime:build-box'
    }),
    run('r10', 'PR 10: avatar upload on server', 'alice/paired-bots-avatar', 19 * min),
    run('r11', 'PR 11: mobile parity', 'alice/paired-bots-mobile', 5 * min, {
      state: 'asking-bot'
    }),
    run('r12', 'PR 12: phone sign-in', 'alice/paired-bots-phone', 2 * min)
  ],
  finished: [
    done('r6', 'PR 6: relay auth review', 'alice/paired-bots-relay-review', 14 * min),
    done('r5', 'PR 5: connectors on server', 'alice/paired-bots-connector-setup', 55 * min)
  ],
  finishedTotal: 11
})
const linear = chat('linear', 'ENG-9312 Duplicate rows in Working on', {
  origin: 'linear',
  lastActiveAt: now - 3 * 3_600_000,
  preview: 'Found it: the worker preamble becomes the title.',
  running: [run('l1', 'Fix duplicate worker titles', 'alice/eng-9312-dup-rows', 18 * min)],
  finished: [
    done('l2', 'Repro ENG-9312 on a fresh bot', 'alice/eng-9312-repro', 9 * min, {
      state: 'failed'
    })
  ]
})
const layout = chat('layout', 'Feedback on HTML layout', {
  origin: 'slack',
  originLabel: '#design',
  lastActiveAt: now - 86_400_000,
  finished: [
    done('h1', 'Mock the layout', 'alice/layout-mock', 9 * min),
    done('h2', 'Shoot the layout', 'alice/layout-shots', 4 * min),
    done('h3', 'Review the layout', 'alice/layout-review', 6 * min)
  ]
})
const review = chat('review', 'Review #40189 dictation retry', {
  origin: 'github',
  originLabel: 'stablyai/orca#40189',
  unread: true,
  lastActiveAt: now - 5 * 3_600_000,
  preview: 'Approved with one nit on the retry backoff.',
  finished: [
    done('g1', 'Address the retry backoff nit', 'alice/dictation-retry-nit', 6 * min),
    done('g2', 'Re-run dictation tests', 'alice/dictation-retry-tests', 9 * min)
  ]
})
const digest = chat('digest', 'Morning standup digest', {
  origin: 'automation',
  originLabel: 'Morning standup digest',
  lastActiveAt: now - 2 * 86_400_000,
  preview: 'Posted the digest to #standup.'
})
const closed = [
  chat('c1', 'Try a second agent on the import flow', {
    closed: true,
    closedAt: now - 6 * 86_400_000,
    lastActiveAt: now - 6 * 86_400_000,
    finished: [done('c1w', 'Import flow with a second agent', 'alice/import-flow', 12 * min)]
  }),
  chat('c2', 'Is the relay down?', {
    origin: 'slack',
    originLabel: '#eng',
    closed: true,
    closedAt: now - 7 * 86_400_000,
    lastActiveAt: now - 7 * 86_400_000,
    preview: 'No, a cell restarted.'
  })
]
const newThread = chat('new-slack', 'Can bots read Slack canvases?', {
  origin: 'slack',
  originLabel: '#bots',
  unseen: true,
  unread: true,
  lastActiveAt: now - 3 * min,
  preview: 'Yes, with the canvases:read scope. Want me to add it?'
})
// A terminal-only automation run: a chat row of its own, with the automation's icon.
const triageRun = chat('run:r1', 'Triage new Orca issues', {
  origin: 'automation',
  live: 'needs-you',
  lastActiveAt: now - 6 * min,
  run: { automationId: 'a1', runId: 'r1', worktreeId: 'repo-1::/triage', paneKey: 't:1' }
})
const CHATS = [
  home,
  slack,
  triageRun,
  draft,
  newThread,
  rollout,
  linear,
  layout,
  review,
  digest,
  ...closed
]

const ACTIVITY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [],
  waits: [],
  upNext: { state: { running: false, seenAt: 1 }, items: [] }
}

const click = (frame: HTMLElement, label: string): void => {
  const button = [...frame.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label
  )
  button?.click()
}

export const normalDay = defineFixture({
  width: 350,
  store: chatsTab('working'),
  setup: stubBotPanel(ACTIVITY, bot, CHATS),
  render: () => <BotPanelFrame />
})

/** Home Chat unfolded: five workers, then Show more. */
export const unfolded = defineFixture({
  width: 350,
  store: chatsTab('working'),
  setup: stubBotPanel(ACTIVITY, bot, CHATS),
  render: () => <BotPanelFrame />,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    frame.querySelector<HTMLButtonElement>('button[aria-label="Unfold Home Chat"]')?.click()
  }
})

/** The older page: the oldest chats, closed ones among them by when they were last used. */
export const olderChats = defineFixture({
  width: 350,
  store: chatsTab('working'),
  setup: stubBotPanel(ACTIVITY, bot, CHATS),
  render: () => <BotPanelFrame />,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    click(frame, 'Show 4 older')
  }
})

export const searchRelay = defineFixture({
  width: 350,
  store: chatsTab('working'),
  setup: stubBotPanel(ACTIVITY, bot, CHATS),
  render: () => <BotPanelFrame />,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const input = frame.querySelector('input')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'relay')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
})

export const narrow = defineFixture({
  width: 220,
  store: chatsTab('working'),
  setup: stubBotPanel(ACTIVITY, bot, CHATS),
  render: () => <BotPanelFrame />
})

export const newBot = defineFixture({
  width: 350,
  store: chatsTab(null),
  setup: stubBotPanel(ACTIVITY, bot, [
    chat('home', 'Home Chat', { origin: 'home', lastActiveAt: now })
  ]),
  render: () => <BotPanelFrame />
})
