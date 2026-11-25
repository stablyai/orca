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
  const failed = (name: string): BotChatTreeWorker => ({
    ...worker(name, 'failed'),
    settledAt: NOW
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
      { finished: [failed('dictation-c4')] },
      { tab: true, unread: true, lastActiveAt: NOW - 20 * 60_000, failedTotal: 1 }
    ),
    ...Array.from({ length: count }, (_, index) =>
      chat(
        `stale-${index}`,
        `${BACKLOG_TITLES[index % BACKLOG_TITLES.length]} ${Math.floor(index / BACKLOG_TITLES.length) + 1}`,
        'side',
        index < 2 ? { finished: [failed(`stale-worker-${index}`)] } : {},
        {
          tab: true,
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

/** One old chat's tab was focused an hour ago: it stays listed while the rest fold. */
export const olderOneFocused = defineFixture({
  ...olderFolded,
  store: {
    ...olderFolded.store,
    unifiedTabsByWorktree: {
      [folderWorkspaceKey(BOT_HOME)]: [
        {
          id: 'tab-stale-3',
          entityId: 'stale-3',
          groupId: 'group-home',
          worktreeId: folderWorkspaceKey(BOT_HOME),
          contentType: 'agent-session',
          label: 'stale-3',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW - 5 * 24 * HOUR,
          lastFocusedAt: NOW - HOUR
        }
      ]
    }
  }
})
