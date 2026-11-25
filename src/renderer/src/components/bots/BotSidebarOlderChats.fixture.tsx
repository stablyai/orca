import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { SidebarBotsSection } from './SidebarBotsSection'

// A reviewer bot after a few days of requests: Home, two chats from today, and settled ones from
// earlier days (some failed) folded under "Show N older". Invented names only.
const NOW = Date.now()
const HOUR = 3_600_000
const DAY = 24 * HOUR

const BOT: Bot = {
  id: 'reviewer',
  name: 'Review desk',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'fw-reviewer',
  agent: 'claude',
  avatar: mascotAvatar('K2'),
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

function chat(
  chatId: string,
  title: string,
  ageMs: number,
  extra: Partial<BotChatTreeChat> = {}
): BotChatTreeChat {
  return {
    chatId,
    title,
    origin: 'side',
    live: 'idle',
    lastActiveAt: NOW - ageMs,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...extra
  }
}

const HOME = chat('home', 'Home Chat', 5 * 60_000, { origin: 'home' })
const TODAY = [
  chat('today-1', 'Settings copy pass, second look', 2 * HOUR),
  chat('today-2', 'Tab strip contrast review', 5 * HOUR)
]
const OLDER = [
  chat('old-1', 'Checkout flow design check', 1.2 * DAY, { failedTotal: 1 }),
  chat('old-2', 'Onboarding hints review', 1.5 * DAY),
  chat('old-3', 'Import dialog wording', 2 * DAY, { failedTotal: 1 }),
  chat('old-4', 'Release notes proofread', 3 * DAY),
  chat('old-5', 'Keyboard map audit', 4 * DAY),
  chat('old-6', 'Empty state illustration check', 4.5 * DAY)
]

function fixtureFor(chats: BotChatTreeChat[], interact?: (frame: HTMLElement) => Promise<void>) {
  return defineFixture({
    // The narrowest the sidebar goes.
    width: 220,
    store: {
      folderWorkspaces: [
        makeFolderWorkspace({
          id: BOT.folderWorkspaceId,
          projectGroupId: 'bots',
          name: BOT.name,
          folderPath: '/home/me/.orca/bots/reviewer'
        })
      ]
    },
    setup: () => {
      stubBots([BOT])
      const runtime = window.api.runtime
      const call = runtime.call.bind(runtime)
      Reflect.set(window.api, 'runtime', {
        ...runtime,
        call: async (request: { method: string }) =>
          request.method === 'bots.chatTree'
            ? { ok: true, result: { chats, workspaceChats: {} } }
            : call(request)
      })
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div className="flex flex-col bg-sidebar py-2 text-sidebar-foreground">
          <SidebarBotsSection onOpenBot={() => {}} />
        </div>
      </ConfirmationDialogProvider>
    ),
    ...(interact ? { interact } : {})
  })
}

async function olderToggle(frame: HTMLElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const toggle = frame.querySelector<HTMLButtonElement>('[data-bot-sidebar-older-toggle]')
    if (toggle) {
      return toggle
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('No older toggle')
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

/** Six settled chats from earlier days, folded: "Show 6 older" under today's chats. */
export const folded = fixtureFor([HOME, ...TODAY, ...OLDER])

/** Opened: the toggle stays put as "Hide older", the older rows below it. */
export const opened = fixtureFor([HOME, ...TODAY, ...OLDER], async (frame) => {
  ;(await olderToggle(frame)).click()
  await settle()
})

/** Only one chat is older: it shows inline, no toggle. */
export const onlyOneOlder = fixtureFor([HOME, ...TODAY, OLDER[0]])

/** Every side chat is older: Home, then the toggle. */
export const allOlder = fixtureFor([HOME, ...OLDER])

/** The toggle with keyboard focus. */
export const toggleFocused = fixtureFor([HOME, ...TODAY, ...OLDER], async (frame) => {
  const toggle = await olderToggle(frame)
  // A key press first, so the browser shows the keyboard focus ring for the focus that follows.
  frame.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  toggle.focus()
  await settle()
})

/** An older chat got a new reply and replies again: it is back up with today's chats. */
export const cameBackLive = fixtureFor([
  HOME,
  ...TODAY,
  { ...OLDER[1], live: 'replying', lastActiveAt: NOW - 60_000 },
  ...OLDER.filter((_, index) => index !== 1)
])

/** A request that failed an hour ago: recent, so it shows, above the fold. */
export const newFailure = fixtureFor([
  HOME,
  chat('fresh-fail', 'Color tokens review', HOUR, { failedTotal: 1 }),
  ...TODAY,
  ...OLDER
])
