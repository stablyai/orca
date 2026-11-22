import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'
import type { FolderWorkspace } from '../../../../src/shared/folder-workspaces/folder-workspace-types'
import type { Bot } from '../../../../src/shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../src/shared/bots/bot-items'

const bot: Bot = {
  id: 'width-bot',
  name: 'Width bot',
  hostId: 'local',
  folder: 'width-bot',
  folderWorkspaceId: 'width-bot-home',
  agent: 'claude',
  avatar: 'mascot:M1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 0,
  updatedAt: 0
}
const home: FolderWorkspace = {
  id: bot.folderWorkspaceId,
  projectGroupId: 'width-group',
  name: bot.name,
  folderPath: '/tmp/orca-isolated-width/width-bot',
  isUnread: false,
  executionHostId: 'local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}
const question =
  "Options: 1. Show the number on every item row and in the item view header, muted, like Linear's ENG-123. 2. Clickable references in chat. 3. Bots stop using numbers and say titles instead."
const item: BotItem = {
  uid: 'width-item',
  number: 73,
  owner: { botId: bot.id, name: bot.name },
  title: 'Show item numbers in lists',
  description: "Bots say 'Item 35' but rows and the item view never show the number.",
  doneMeans: null,
  status: 'needs_you',
  chat: { id: 'width-chat', kind: 'home', title: 'Home Chat' },
  madeBy: null,
  question: { eventId: 'width-question', text: question },
  closeNote: null,
  links: [],
  version: 1,
  lastEventId: 'width-question',
  othersLastEventId: 'width-question',
  snoozedUntil: null,
  // Recent, so the row lists under Needs you rather than folded into Stale.
  lastActivityAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  closedAt: null
}
const events: BotItemEvent[] = [
  {
    id: 'width-question',
    kind: 'commented',
    actor: { kind: 'bot', botId: bot.id, chatId: 'width-chat' },
    data: { text: question },
    at: 1
  }
]

// IPC doubles stay inside the fixture's isolated Electron process; no real bot or agent session starts.
test('an item with an open question lays out within the bot panel', async ({
  electronApp,
  orcaPage: page
}) => {
  await waitForSessionReady(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await electronApp.evaluate(
    ({ ipcMain, BrowserWindow }, scene) => {
      if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
        throw new Error('This Electron runtime does not expose the fixture handler map')
      }
      const handlers: Map<string, (...args: unknown[]) => unknown> = ipcMain._invokeHandlers
      const original = handlers.get('runtime:call')!
      const results: Record<string, unknown> = {
        'bots.list': { bots: [scene.bot] },
        'bots.items.owner.list': {
          items: [scene.item],
          counts: { needs_you: 1 },
          seenEventId: scene.item.lastEventId
        },
        'bots.items.owner.show': { item: scene.item, events: scene.events },
        'bots.items.owner.opened': {},
        'bots.upNext.unseen': { unseen: {} },
        'bots.activity': {
          activity: { workers: [], inProgress: [], completed: [], automations: [], waits: [] }
        }
      }
      ipcMain.removeHandler('runtime:call')
      ipcMain.handle('runtime:call', (event, args) =>
        args.method in results ? { ok: true, result: results[args.method] } : original(event, args)
      )
      ipcMain.removeHandler('folderWorkspaces:list')
      ipcMain.handle('folderWorkspaces:list', () => [scene.home])
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('repos:changed')
      }
    },
    { bot, home, item, events }
  )
  await page.evaluate((folder) => {
    window.__store!.setState({ folderWorkspaces: [folder], collapsedGroups: new Set() })
  }, home)
  await page.locator('[data-bot-sidebar-list]').getByText(bot.name, { exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.__store!.getState().activeWorkspaceKey))
    .toBe(`folder:${home.id}`)
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.setRightSidebarWidth(340)
    state.setRightSidebarOpen(true)
    state.setRightSidebarTab('bot-activity')
  })
  await page.getByText(item.title, { exact: true }).first().click()
  const pane = page.locator('[data-bot-item-pane]')
  await expect(pane.getByText('Answering:')).toBeVisible()

  // The question's one-line "Answering:" row must not set the item view's width.
  const widths = await pane.evaluate((node) => ({
    pane: node.getBoundingClientRect().width,
    view: node.querySelector('fieldset')!.getBoundingClientRect().width
  }))
  expect(widths.view).toBeLessThanOrEqual(widths.pane)
  const reply = await pane.getByRole('button', { name: 'Reply' }).boundingBox()
  const box = await pane.boundingBox()
  expect(reply!.x + reply!.width).toBeLessThanOrEqual(box!.x + box!.width)
})
