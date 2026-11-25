import { defineFixture } from '../../component-fixtures/component-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { chat, clickText, fixtureFor, HOUR, NOW, worker } from './bot-sidebar-entry-fixture'

const HOME_WORKERS = [
  worker('paired-bots-relay-auth', 'needs-you'),
  worker('phone-one-bots-list', 'running'),
  worker('agy-bot-agent', 'asking-bot'),
  worker('relay-reconnect-flake', 'running', 'handed-over'),
  worker('zip-import-fix', 'running', 'from-closed-chat')
]
const ROLLOUT = [
  'paired-bots-create',
  'paired-bots-signin',
  'paired-bots-list-sync',
  'paired-bots-avatar',
  'paired-bots-mobile',
  'paired-bots-relay-review'
].map((name) => worker(name, 'running'))

const QUIET_TITLES = [
  'Why does the relay cell restart at 2 AM?',
  'Plan the phone bots list',
  'Draft the Slack scopes note',
  'Look into the flaky dictation test',
  'Compare paired sign-in flows',
  'Summarize yesterday’s merges',
  'Find the slow startup step',
  'Write the 1.4.229 notes',
  'Check the relay dashboards',
  'Triage the Linear inbox',
  'Review the onboarding copy',
  'Tidy the bot templates'
]

function normalDay(homeWorkers: BotChatTreeWorker[]): BotChatTreeChat[] {
  return [
    chat(
      'home',
      'Home Chat',
      'home',
      { running: homeWorkers, finished: [worker('slack-scope-check', 'done')] },
      { tab: true, live: 'replying' }
    ),
    chat(
      'slack-1',
      'Why ux-designer didn’t reply',
      'slack',
      { running: [worker('fix-reply-routing', 'running')] },
      { live: 'needs-you', originLabel: '#ui-ux-design', tab: true, lastActiveAt: NOW - 60_000 }
    ),
    chat('side-1', 'Draft the 1.4.230 release notes', 'side', {}, { live: 'replying', tab: true }),
    chat(
      'side-2',
      'Paired bots rollout',
      'side',
      {
        running: ROLLOUT,
        finished: [
          worker('paired-bots-relay-review', 'done'),
          worker('paired-bots-docs-outline', 'done'),
          ...Array.from({ length: 9 }, (_, index) => worker(`rollout-done-${index}`, 'done'))
        ]
      },
      { tab: true, lastActiveAt: NOW - 20 * 60_000 }
    ),
    chat(
      'linear-1',
      'ENG-9312 Duplicate rows in Working on',
      'linear',
      { finished: [worker('eng-9312-dup-rows', 'done')] },
      { tab: true, unread: true, lastActiveAt: NOW - 12 * 60_000 }
    ),
    chat('new-1', 'Can bots read Slack canvases?', 'slack', {}, { unseen: true }),
    chat('new-2', 'ENG-9330 Paste drops images on Windows', 'linear', {}, { unseen: true }),
    chat('auto-1', '2 PRs wait on your review', 'automation', {}, { unread: true }),
    chat(
      'gh-1',
      'Review #40189 dictation retry',
      'github',
      {
        finished: [worker('dictation-retry', 'done'), worker('dictation-retry-tests', 'done')]
      },
      { tab: true, lastActiveAt: NOW - 2 * HOUR }
    ),
    chat('auto-2', 'Tidy-up', 'automation', {}, { lastActiveAt: NOW - 14 * HOUR }),
    chat('slack-2', 'Feedback on HTML layout', 'slack', {
      finished: [
        worker('html-layout-a', 'done'),
        worker('html-layout-b', 'done'),
        worker('html-layout-c', 'done')
      ]
    }),
    chat('auto-3', 'Look around', 'automation', {}, { lastActiveAt: NOW - 26 * HOUR }),
    ...QUIET_TITLES.map((title, index) =>
      chat(
        `quiet-${index}`,
        title,
        'side',
        {},
        {
          lastActiveAt: NOW - (30 + index) * HOUR,
          // One old chat still has its tab open.
          tab: index === 0
        }
      )
    ),
    chat('closed-1', 'Zip import parser', 'side', {}, { closed: true })
  ]
}

/** v3: only the open tabs, each chat's live lines then its last 2 finished; the new threads stay off the list. */
export const normal = fixtureFor(normalDay(HOME_WORKERS))

/** Two live chats folded by hand: live counts, then the chevron at the right edge. */
export const folded = fixtureFor(normalDay(HOME_WORKERS), { home: 'folded', 'side-2': 'folded' })

/** A selected worker with 12 child workspaces, folded under its children pill, between its neighbours. */
export const selectedWithChildren = defineFixture({
  ...fixtureFor(normalDay(HOME_WORKERS), {}, false, {
    worker: 'phone-one-bots-list',
    children: 12
  }),
  interact: async (frame) => {
    await clickText(frame, '12 children')
  }
})

/** The whole bot folded: it reads none of its chats. */
export const botFolded = fixtureFor(normalDay(HOME_WORKERS), {}, true)

/** After one step on the rollout chat: 8 more finished lines, then Show fewer. */
export const linesStep = defineFixture({
  ...normal,
  interact: async (frame) => {
    await clickText(frame, 'Show 8 more')
  }
})

const RUN = 'daily-linear-triage-2026-11-17'
const RUN_LANES: [string, string][] = [
  ['lt1117-question-prose', RUN],
  ['qa-pr-43797', 'lt1117-question-prose'],
  ['lt1117-security-tests', RUN],
  ['lt1117-proxy-env', RUN],
  ['lt1117-vietnamese-enter', RUN],
  ['lt1117-community-qa', RUN]
]

/** A triage run's coordinator, dispatched from its automation chat (no tab), with lanes under it. */
function runFixture(runOpen: boolean) {
  const base = fixtureFor([
    chat('home', 'Home Chat', 'home', {}, { tab: true, lastActiveAt: NOW - 51 * 60_000 }),
    chat('run', 'Daily Linear triage', 'automation', { running: [worker(RUN, 'running')] })
  ])
  const line = (name: string) =>
    makeWorktree({
      id: `repo-1::/${name}`,
      instanceId: `${name}-instance`,
      repoId: 'repo-1',
      path: `/${name}`,
      displayName: name
    })
  const run = line(RUN)
  const lanes = RUN_LANES.map(([name]) => line(name))
  const lineage = Object.fromEntries(
    RUN_LANES.map(([name, parent]) => [
      `repo-1::/${name}`,
      {
        worktreeId: `repo-1::/${name}`,
        worktreeInstanceId: `${name}-instance`,
        parentWorktreeId: `repo-1::/${parent}`,
        parentWorktreeInstanceId: `${parent}-instance`,
        origin: 'orchestration' as const,
        capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    ])
  )
  return defineFixture({
    ...base,
    store: {
      ...base.store,
      worktreesByRepo: { 'repo-1': [run, ...lanes] },
      worktreeLineageById: lineage,
      ...(runOpen
        ? { activeWorktreeId: run.id, activeWorkspaceKey: worktreeWorkspaceKey(run.id) }
        : {})
    }
  })
}

/** Another row is open: the run stays listed after the chats, its lanes at one level. */
export const runListed = runFixture(false)

/** Opened from a notification: the same row, selected in place. */
export const runOpen = runFixture(true)
