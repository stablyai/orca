import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import {
  botChatFoldKey,
  type BotChatTreeChat,
  type BotChatTreeRead,
  type BotChatTreeWorker
} from '../../../../shared/bots/bot-chat-tree'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { SidebarBotsSection } from './SidebarBotsSection'
import { getLineageGroupKey } from '../../../../shared/sidebar-list/sections/group-keys'

const NOW = Date.now()
const HOUR = 3_600_000

const BOT: Bot = {
  id: 'builder',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'builder',
  folderWorkspaceId: 'fw-builder',
  agent: 'claude',
  avatar: mascotAvatar('F1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'home',
  sidebarOrder: 0,
  createdAt: 1,
  updatedAt: 1
}

const worker = (
  name: string,
  state: BotChatTreeWorker['state'],
  note?: BotChatTreeWorker['note']
): BotChatTreeWorker => ({
  key: name,
  title: name,
  state,
  startedAt: NOW - HOUR,
  worktreeId: `repo-1::/${name}`,
  ...(note ? { note } : {})
})

function chat(
  chatId: string,
  title: string,
  origin: BotChatTreeChat['origin'],
  workers: { running?: BotChatTreeWorker[]; finished?: BotChatTreeWorker[] },
  extra: Partial<BotChatTreeChat> = {}
): BotChatTreeChat {
  const running = workers.running ?? []
  const finished = workers.finished ?? []
  return {
    chatId,
    title,
    origin,
    live: 'idle',
    lastActiveAt: NOW - HOUR,
    unread: false,
    closed: false,
    tab: false,
    running,
    runningTotal: running.length,
    finished,
    finishedTotal: finished.length,
    failedTotal: 0,
    ...extra
  }
}

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

function treeOf(chats: BotChatTreeChat[]): BotChatTreeRead {
  const workspaceChats: Record<string, string> = {}
  for (const entry of chats) {
    for (const each of [...entry.running, ...entry.finished]) {
      workspaceChats[each.worktreeId!] = entry.chatId
    }
  }
  return { chats, workspaceChats }
}

function fixtureFor(
  chats: BotChatTreeChat[],
  folds: Record<string, 'open' | 'folded'> = {},
  botFolded = false,
  /** One worker, selected, with this many child workspaces of its own. */
  selected?: { worker: string; children: number }
) {
  const tree = treeOf(chats)
  const line = (id: string) => {
    const name = id.slice('repo-1::/'.length)
    return makeWorktree({
      id,
      instanceId: `${name}-instance`,
      repoId: 'repo-1',
      path: `/${name}`,
      displayName: name
    })
  }
  const lines = Object.keys(tree.workspaceChats).map(line)
  const selectedId = selected ? `repo-1::/${selected.worker}` : null
  const children = selected
    ? Array.from({ length: selected.children }, (_, index) =>
        line(`repo-1::/${selected.worker}-child-${index}`)
      )
    : []
  const worktrees = [...lines, ...children]
  return defineFixture({
    width: 260,
    store: {
      folderWorkspaces: [
        makeFolderWorkspace({
          id: BOT.folderWorkspaceId,
          projectGroupId: 'bots',
          name: BOT.name,
          folderPath: '/home/me/.orca/bots/builder'
        })
      ],
      worktreesByRepo: { 'repo-1': worktrees },
      workspaceLineageByChildKey: Object.fromEntries(
        lines.map((worktree) => [
          worktreeWorkspaceKey(worktree.id),
          {
            childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
            parentWorkspaceKey: folderWorkspaceKey(BOT.folderWorkspaceId),
            origin: 'orchestration' as const,
            capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
            createdAt: 1
          }
        ])
      ),
      worktreeLineageById: Object.fromEntries(
        children.map((child) => [
          child.id,
          {
            worktreeId: child.id,
            worktreeInstanceId: child.instanceId ?? '',
            parentWorktreeId: selectedId!,
            parentWorktreeInstanceId:
              lines.find((each) => each.id === selectedId)?.instanceId ?? '',
            origin: 'orchestration' as const,
            capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
            createdAt: 1
          }
        ])
      ),
      ...(selectedId
        ? { activeWorktreeId: selectedId, activeWorkspaceKey: worktreeWorkspaceKey(selectedId) }
        : {}),
      ...(botFolded
        ? {
            collapsedGroups: new Set([
              getLineageGroupKey(folderWorkspaceKey(BOT.folderWorkspaceId))
            ])
          }
        : {}),
      botChatFolds: Object.fromEntries(
        Object.entries(folds).map(([chatId, fold]) => [
          botChatFoldKey('local', BOT.id, chatId),
          fold
        ])
      )
    },
    setup: () => {
      stubBots([BOT])
      const runtime = window.api.runtime
      const call = runtime.call.bind(runtime)
      Reflect.set(window.api, 'runtime', {
        ...runtime,
        call: async (request: { method: string }) =>
          request.method === 'bots.chatTree' ? { ok: true, result: tree } : call(request)
      })
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div className="flex flex-col bg-sidebar py-2 text-sidebar-foreground">
          <SidebarBotsSection onOpenBot={() => {}} />
        </div>
      </ConfirmationDialogProvider>
    )
  })
}

// Waits for the chats read to land, then clicks the "Show more" link that starts with this text.
async function clickText(frame: HTMLElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const button = [...frame.querySelectorAll('button')].find((each) =>
      each.textContent?.startsWith(text)
    )
    if (button) {
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`No "${text}" button`)
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

/** Side chats whose items are all done or canceled: counting, paused, and one Orca closed, still
 *  listed with its Reopen; one closed by hand drops off the list. */
const side = (id: string, title: string, extra: Partial<BotChatTreeChat>) =>
  chat(id, title, 'side', {}, extra)
const SOON = { phase: 'counting', closesAt: NOW + 2 * 60_000 } as const
const CLOSED_BY_ORCA = { closed: true, closedAt: NOW - HOUR / 4, autoClosedAt: NOW - HOUR / 4 }
export const autoClose = fixtureFor([
  chat('home', 'Home Chat', 'home', {}, { tab: true, lastActiveAt: NOW - HOUR / 6 }),
  side('side-soon', 'Share dialog copy fix', { tab: true, autoClose: SOON }),
  side('side-paused', 'Relay reconnect flake', { tab: true, autoClose: { phase: 'held' } }),
  side('side-closed', 'Zip import parser', CLOSED_BY_ORCA),
  side('side-by-hand', 'Draft the release notes', { closed: true, closedAt: NOW - HOUR })
])
