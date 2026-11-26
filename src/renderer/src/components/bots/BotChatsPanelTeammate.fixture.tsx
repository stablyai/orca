// A shared agent's Chats tab on a teammate's computer: it opens on their own chats, and Everyone names
// the others', the owner's included.
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
const ALICE = { accountId: 'acc-alice', name: 'Alice Park' }
const BO = { accountId: 'acc-bo', name: 'Bo Chen' }
const bot = {
  ...fixtureCos,
  name: 'Bot builder',
  shareViewer: { accountId: ALICE.accountId, ownerName: 'Jinwoo', teammates: [ALICE, BO] }
}
const ACTIVITY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [],
  waits: [],
  upNext: { state: { running: false, seenAt: 1 }, items: [] }
}
const worker = (key: string, title: string, branch: string, ago: number): BotChatTreeWorker => ({
  key,
  title,
  branch,
  state: 'running',
  startedAt: now - ago,
  dispatchId: key,
  agent: 'claude'
})
const chat = fixtureChat
const CHATS = [
  chat('home', 'Home Chat', {
    origin: 'home',
    person: ALICE,
    lastActiveAt: now - 12 * min,
    preview: 'The installer FAQ draft is up; one question on the admin step.',
    running: [worker('w-faq', 'Draft the Windows installer FAQ', 'installer-faq', 12 * min)],
    runningTotal: 1
  }),
  chat('crashes', 'Check the crash reports for 1.4.231', {
    origin: 'slack',
    originLabel: '#releases',
    person: ALICE,
    lastActiveAt: now - 2 * min,
    preview: 'Two workers are on the updater crash; the restart step fails on a locked file.',
    running: [
      worker('w-fix', 'Fix the updater crash on Windows 10', 'fix-updater-crash-win10', 41 * min),
      worker('w-repro', 'Repro the crash on a clean Windows 10 VM', 'updater-crash-repro', 18 * min)
    ],
    runningTotal: 2
  }),
  chat('owner-home', 'Home Chat', {
    homeOf: 'Jinwoo',
    lastActiveAt: now - 6 * min,
    preview: 'Merged the plugin download cleanup; the 1.4.232 notes are next.',
    running: [worker('w-notes', 'Draft the 1.4.232 release notes', 'release-notes', 9 * min)],
    runningTotal: 1
  }),
  chat('installer', 'Why the Windows installer still asks for admin', {
    person: ALICE,
    lastActiveAt: now - 21 * min,
    preview: 'Fixed in 1.4.231: a per-user install no longer asks for admin rights.'
  }),
  chat('notes', 'Plan the 1.4.232 cut', {
    lastActiveAt: now - 64 * min,
    preview: 'Three fixes are queued; the updater one goes first.'
  }),
  chat('onboarding', 'Draft the onboarding checklist for new hires', {
    person: BO,
    lastActiveAt: now - 95 * min,
    preview: 'The draft is in docs/onboarding.md; IT still owes the laptop step.'
  })
]
const page = { ...botPanelPage(true, 'working'), rightSidebarTab: 'bot-chats' as const }
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const openFilter = async (frame: HTMLElement): Promise<void> => {
  await settle(300)
  frame
    .querySelector('button[aria-label^="Filter by person"]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  await settle(200)
}
const fixture = (interact?: (frame: HTMLElement) => Promise<void>) =>
  defineFixture({
    width: 420,
    store: page,
    setup: stubBotPanel(ACTIVITY, bot, CHATS),
    render: () => <BotPanelFrame />,
    ...(interact ? { interact } : {})
  })

export const mine = fixture()
export const filterOpen = fixture(openFilter)
export const everyone = fixture(async (frame) => {
  await openFilter(frame)
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((entry) => entry.textContent?.trim() === 'Everyone')
    ?.click()
  await settle(200)
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
})
