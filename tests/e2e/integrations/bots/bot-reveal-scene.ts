// The bot "Reveal current" specs' scene: one stubbed bot with a home, two chats and, when asked, a
// worker workspace under it; a sidebar filter on.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import type { FolderWorkspace } from '../../../../src/shared/folder-workspaces/folder-workspace-types'
import type { Bot } from '../../../../src/shared/bot-types'
import type { WorkspaceLineage } from '../../../../src/shared/worktree/lineage-types'

export const bot: Bot = {
  id: 'reveal-bot',
  name: 'Builder bot',
  hostId: 'local',
  folder: 'reveal-bot',
  folderWorkspaceId: 'reveal-bot-home',
  agent: 'claude',
  avatar: 'mascot:A1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'reveal-chat-home',
  createdAt: 1,
  updatedAt: 1
}
export const home: FolderWorkspace = {
  id: bot.folderWorkspaceId,
  projectGroupId: 'reveal-bots-group',
  name: bot.name,
  folderPath: '/tmp/orca-isolated-reveal/reveal-bot',
  executionHostId: 'local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}
export const CHAT_ID = 'reveal-chat-login'
export const HOME_CHAT_ID = bot.chatSessionId!
export const chatTree = {
  chats: [
    {
      chatId: HOME_CHAT_ID,
      title: 'Home',
      origin: 'home',
      live: 'idle',
      lastActiveAt: 2,
      unread: false,
      closed: false,
      tab: true,
      running: [],
      runningTotal: 0,
      finished: [],
      finishedTotal: 0,
      failedTotal: 0
    },
    {
      chatId: CHAT_ID,
      title: 'Fix the login redirect',
      origin: 'side',
      live: 'idle',
      lastActiveAt: 1,
      unread: false,
      closed: false,
      tab: true,
      running: [],
      runningTotal: 0,
      finished: [],
      finishedTotal: 0,
      failedTotal: 0
    }
  ],
  workspaceChats: {}
}

export type Worker = { worktreeId: string; repoId: string; instanceId: string }

/** The worker workspace is one the bot made: its lineage puts it under the bot's home. Naming the
 *  row's instance lets this record outrank the host's own inline edge (no parent). */
export function workerLineage(worker: Worker): Record<string, WorkspaceLineage> {
  const key = `worktree:${worker.worktreeId}` as const
  return {
    [key]: {
      childWorkspaceKey: key,
      childInstanceId: worker.instanceId,
      parentWorkspaceKey: `folder:${home.id}`,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      createdAt: 1
    }
  }
}

// IPC doubles stay inside the fixture's isolated Electron process; no real bot runs. The lineage
// list answers with the bot's worker too, so a background refresh keeps it under the bot.
export async function stubBot(
  electronApp: ElectronApplication,
  workspaceChats: Record<string, string>,
  workspaceLineage: Record<string, WorkspaceLineage> = {}
): Promise<void> {
  await electronApp.evaluate(
    ({ ipcMain, BrowserWindow }, scene) => {
      if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
        throw new Error('This Electron runtime does not expose the fixture handler map')
      }
      const handlers: Map<string, (...args: unknown[]) => unknown> = ipcMain._invokeHandlers
      const original = handlers.get('runtime:call')!
      ipcMain.removeHandler('runtime:call')
      ipcMain.handle('runtime:call', (event, args) => {
        const answers: Record<string, unknown> = {
          'bots.list': { bots: [scene.bot] },
          'bots.groups.list': { groups: [] },
          'bots.upNext.unseen': { unseen: {} },
          'bots.chatTree': scene.chatTree,
          'bots.activity': {
            activity: { workers: [], inProgress: [], completed: [], automations: [] }
          }
        }
        return args.method in answers
          ? { ok: true, result: answers[args.method] }
          : original(event, args)
      })
      ipcMain.removeHandler('folderWorkspaces:list')
      ipcMain.handle('folderWorkspaces:list', () => [scene.home])
      const listLineage = handlers.get('worktrees:listLineage')!
      ipcMain.removeHandler('worktrees:listLineage')
      ipcMain.handle('worktrees:listLineage', async (event) => {
        const listed: unknown = await listLineage(event)
        if (typeof listed !== 'object' || listed === null) {
          return listed
        }
        const own = 'workspaceLineage' in listed ? listed.workspaceLineage : undefined
        return {
          ...listed,
          workspaceLineage: {
            ...(typeof own === 'object' && own !== null ? own : {}),
            ...scene.workspaceLineage
          }
        }
      })
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('repos:changed')
      }
    },
    { bot, home, chatTree: { ...chatTree, workspaceChats }, workspaceLineage }
  )
}

/** A sidebar filter on, and `front` in front: a side chat of the bot, the bot's page
 *  (its home on its Home tab), or a worker workspace the bot made. */
export async function openScene(
  page: Page,
  front:
    | { kind: 'chat' }
    | { kind: 'page' }
    | (Worker & { kind: 'worker'; lineage: Record<string, WorkspaceLineage> })
): Promise<void> {
  await page.evaluate(
    ({ folder, chatId, homeChatId, front }) => {
      const homeKey = `folder:${folder.id}` as const
      // The home's tab in front: its Home chat on the bot's page, else the side chat.
      const frontChatId = front.kind === 'page' ? homeChatId : chatId
      const tabId = `structured-agent-session-${frontChatId}`
      const state = window.__store!.getState()
      const workerKey = front.kind === 'worker' ? (`worktree:${front.worktreeId}` as const) : null
      window.__store!.setState({
        folderWorkspaces: [...state.folderWorkspaces.filter((f) => f.id !== folder.id), folder],
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [homeKey]: [
            {
              id: tabId,
              entityId: frontChatId,
              worktreeId: homeKey,
              groupId: 'reveal-group',
              contentType: 'agent-session',
              agentSessionAgent: 'claude',
              label: front.kind === 'page' ? 'Home' : 'Fix the login redirect',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [homeKey]: [
            { id: 'reveal-group', worktreeId: homeKey, activeTabId: tabId, tabOrder: [tabId] }
          ]
        },
        activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [homeKey]: 'reveal-group' },
        workspaceLineageByChildKey:
          front.kind === 'worker'
            ? { ...state.workspaceLineageByChildKey, ...front.lineage }
            : state.workspaceLineageByChildKey,
        hideBotCreatedWorkspaces: true,
        activeView: 'terminal',
        sidebarOpen: true,
        activeRepoId: front.kind === 'worker' ? front.repoId : state.activeRepoId,
        activeWorkspaceKey: workerKey ?? homeKey,
        activeWorktreeId: front.kind === 'worker' ? front.worktreeId : null,
        activeWorkspaceExecutionHostId: 'local',
        pendingRevealWorktree: null
      })
      // A Projects filter is on: the owner's state.
      window.__store!.getState().setShowSleepingWorkspaces(false)
    },
    { folder: home, chatId: CHAT_ID, homeChatId: HOME_CHAT_ID, front }
  )
}

/** Folds the Bots section once the bot is listed (an empty section can't fold), so the reveal must
 *  unfold it. */
export async function foldBots(page: Page): Promise<void> {
  const entry = page.locator(`[data-bot-sidebar-entry="local/${bot.id}"]`)
  await expect(entry).toBeVisible()
  await page.evaluate(() => {
    const state = window.__store!.getState()
    if (!state.collapsedGroups.has('bots')) {
      state.toggleCollapsedGroup('bots')
    }
  })
  await expect(entry).toHaveCount(0)
}

/** A row for the workspace outside the Bots section, which is to say in Projects. */
export async function listedInProjects(page: Page, worktreeId: string): Promise<boolean> {
  return page.evaluate(
    (id) =>
      [
        ...document.querySelectorAll<HTMLElement>('[data-worktree-sidebar] [data-worktree-id]')
      ].some((row) => row.dataset.worktreeId === id && !row.closest('[data-bot-sidebar-entry]')),
    worktreeId
  )
}

export const filterDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Reveal hidden workspace?' })

export async function readAfter(page: Page) {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    return { showSleeping: state.showSleepingWorkspaces, pending: state.pendingRevealWorktree }
  })
}

export async function capture(page: Page, name: string): Promise<void> {
  const evidence = process.env.ORCA_REVEAL_EVIDENCE_DIR
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: path.join(evidence, name) })
  }
}

/** Whether the row draws the reveal glow as the app renders it: an outline drawn over the row. */
export async function drawsRevealGlow(row: Locator): Promise<boolean> {
  return row.evaluate((element) => {
    const glow = getComputedStyle(element, '::before')
    return glow.content !== 'none' && glow.borderTopStyle === 'solid' && glow.boxShadow !== 'none'
  })
}

/** In view and glowing: what the reveal shows. */
export async function expectRevealed(row: Locator): Promise<void> {
  await expect(row).toBeInViewport()
  await expect.poll(() => drawsRevealGlow(row)).toBe(true)
}
