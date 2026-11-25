import { defineFixture } from '../../component-fixtures/component-fixture'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { chat, clickText, fixtureFor, HOUR, NOW, worker } from './bot-sidebar-entry-fixture'

const BOT_HOME = 'fw-builder'
const BACKLOG_TITLES = [
  'Cmd+J C2 independent check',
  'Raw mentions D1 review',
  'Session wording C5 independent check',
  'Independent counted C11 review',
  'Paste images D2 review',
  'Relay retry C3 independent check'
]

/** Four days of failed review requests, an old chat still waiting on the owner, a failure from today. */
function backlogDay(count: number): BotChatTreeChat[] {
  const failed = (name: string, at: number): BotChatTreeWorker => ({
    ...worker(name, 'failed'),
    startedAt: at - 60_000,
    settledAt: at
  })
  return [
    chat('home', 'Home Chat', 'home', {}, { tab: true, lastActiveAt: NOW - 40 * 60_000 }),
    chat(
      'old-asks',
      'Which retry limit should relay use?',
      'side',
      {},
      { tab: true, live: 'needs-you', lastActiveAt: NOW - 3 * 24 * HOUR }
    ),
    chat(
      'fresh-fail',
      'Dictation retry C4 independent check',
      'side',
      { finished: [failed('dictation-c4', NOW - 20 * 60_000)] },
      { tab: true, unread: true, lastActiveAt: NOW - 20 * 60_000, failedTotal: 1 }
    ),
    // Four minutes short of a day: it folds once the clock passes the day mark, unless held.
    chat(
      'near-day',
      'Relay docs C6 independent check',
      'side',
      {},
      { tab: true, lastActiveAt: NOW - 24 * HOUR + 4 * 60_000 }
    ),
    ...Array.from({ length: count }, (_, index) =>
      chat(
        `stale-${index}`,
        `${BACKLOG_TITLES[index % BACKLOG_TITLES.length]} ${Math.floor(index / BACKLOG_TITLES.length) + 1}`,
        'side',
        index < 2
          ? { finished: [failed(`stale-worker-${index}`, NOW - (4 * 24 + index) * HOUR)] }
          : {},
        {
          tab: true,
          // A /clear moved this one on: its tab shows the successor session.
          ...(index === 5 ? { liveSessionId: 'stale-5-next' } : {}),
          unread: index % 3 === 0,
          lastActiveAt: NOW - (4 * 24 + index) * HOUR,
          failedTotal: index < 2 ? 1 : 0
        }
      )
    )
  ]
}

/** A backlog of old settled chats folds under one link; the old chat waiting on you and today's failure stay. */
export const olderFolded = fixtureFor(backlogDay(30))

/** The same backlog after "Show 30 older": every old chat listed, then Show fewer. */
export const olderShown = defineFixture({
  ...olderFolded,
  interact: async (frame) => {
    await clickText(frame, 'Show 30 older')
  }
})

const HOME_KEY = folderWorkspaceKey(BOT_HOME)

/** A tab in the bot's home showing `sessionId`, focused at `focusedAt` (none: never focused). */
function homeTab(sessionId: string, focusedAt?: number) {
  return {
    id: `tab-${sessionId}`,
    entityId: sessionId,
    groupId: 'group-home',
    worktreeId: HOME_KEY,
    contentType: 'agent-session' as const,
    label: sessionId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW - 5 * 24 * HOUR,
    ...(focusedAt === undefined ? {} : { lastFocusedAt: focusedAt })
  }
}

/** One old chat's tab was focused an hour ago: it stays listed while the rest fold. */
export const olderOneFocused = defineFixture({
  ...olderFolded,
  store: {
    ...olderFolded.store,
    unifiedTabsByWorktree: { [HOME_KEY]: [homeTab('stale-3', NOW - HOUR)] }
  }
})

/** In front: an old chat's tab after /clear, showing its successor session, with no focus time. */
export const olderSuccessorInFront = defineFixture({
  ...olderFolded,
  store: {
    ...olderFolded.store,
    activeView: 'terminal',
    activeWorkspaceKey: HOME_KEY,
    unifiedTabsByWorktree: { [HOME_KEY]: [homeTab('stale-5-next')] },
    groupsByWorktree: {
      [HOME_KEY]: [
        {
          id: 'group-home',
          worktreeId: HOME_KEY,
          activeTabId: 'tab-stale-5-next',
          tabOrder: ['tab-stale-5-next']
        }
      ]
    },
    activeGroupIdByWorktree: { [HOME_KEY]: 'group-home' }
  }
})
