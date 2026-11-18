import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'
import type { FolderWorkspace } from '../../../../src/shared/folder-workspaces/folder-workspace-types'
import { makePaneKey } from '../../../../src/shared/workspace-layout/stable-pane-id'
import type { Bot } from '../../../../src/shared/bot-types'

const names = [
  'Disk Space',
  'Triage bot',
  'Release manager',
  'Builder bot',
  'Support bot',
  'Deploy bot',
  'QA bot',
  'Docs bot'
]
const bots: Bot[] = names.map((name, index) => ({
  id: `polish-${index}`,
  name,
  hostId: 'local',
  folder: `polish-${index}`,
  folderWorkspaceId: `polish-home-${index}`,
  agent: 'claude',
  avatar: `mascot:${['M1', 'T1', 'G1', 'A1', 'B1', 'H1', 'J1', 'O1'][index]}`,
  paused: index === 6,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: index,
  updatedAt: index
}))
const homes: FolderWorkspace[] = bots.map((bot, index) => ({
  id: bot.folderWorkspaceId,
  projectGroupId: 'polish-group',
  name: bot.name,
  folderPath: `/tmp/orca-isolated-polish/${bot.folder}`,
  isUnread: index < 7,
  executionHostId: 'local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isPinned: false,
  sortOrder: index,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}))

async function capture(page: Page, evidence: string, name: string): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {}))
    )
  )
  await page.screenshot({ path: path.join(evidence, name) })
}

// IPC doubles stay inside the fixture's isolated Electron process; no real bots or agent sessions start.
for (const count of [0, 4, 8]) {
  test(`bots preview and settings retain real desktop controls with ${count} bots`, async ({
    electronApp,
    orcaPage: page
  }, testInfo) => {
    await waitForSessionReady(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    const evidence = process.env.ORCA_BOTS_EVIDENCE_DIR ?? testInfo.outputPath('bots-polish')
    mkdirSync(evidence, { recursive: true })
    await electronApp.evaluate(
      ({ ipcMain, BrowserWindow }, scene) => {
        if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
          throw new Error('This Electron runtime does not expose the fixture handler map')
        }
        const handlers: Map<string, (...args: unknown[]) => unknown> = ipcMain._invokeHandlers
        const original = handlers.get('runtime:call')!
        ipcMain.removeHandler('runtime:call')
        ipcMain.handle('runtime:call', (event, args) => {
          if (args.method === 'bots.create') {
            const bot = { ...scene.firstBot, ...args.params }
            scene.bots.push(bot)
            scene.homes.push({ ...scene.firstHome, name: bot.name })
            return { ok: true, result: { bot } }
          }
          if (args.method === 'bots.chat.open') {
            throw new Error('The isolated fixture has no running bot chat')
          }
          if (args.method === 'bots.list') {
            return { ok: true, result: { bots: scene.bots } }
          }
          if (args.method === 'bots.upNext.unseen') {
            return {
              ok: true,
              result: { unseen: Object.fromEntries(scene.bots.map((bot) => [bot.id, 2])) }
            }
          }
          if (args.method === 'bots.activity') {
            return {
              ok: true,
              result: { activity: { workers: [], inProgress: [], completed: [], automations: [] } }
            }
          }
          if (args.method === 'bots.update') {
            const bot = scene.bots.find((bot) => bot.id === args.params.botId)
            if (bot) {
              Object.assign(bot, args.params.updates)
            }
            return { ok: true, result: { bot } }
          }
          return original(event, args)
        })
        const readFile = handlers.get('fs:readFile')!
        ipcMain.removeHandler('fs:readFile')
        ipcMain.handle('fs:readFile', (event, args) =>
          args.filePath.startsWith('/tmp/orca-isolated-polish/')
            ? {
                content: args.filePath.endsWith('SOUL.md')
                  ? 'Keep the release work moving. Ask before acting.'
                  : '',
                isBinary: false
              }
            : readFile(event, args)
        )
        ipcMain.removeHandler('folderWorkspaces:list')
        ipcMain.handle('folderWorkspaces:list', () => scene.homes)
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('repos:changed')
        }
      },
      {
        bots: bots.slice(0, count),
        homes: homes.slice(0, count),
        firstBot: bots[0]!,
        firstHome: homes[0]!
      }
    )
    await page.evaluate(
      ({ folders, panes }) => {
        const state = window.__store!.getState()
        const unified = { ...state.unifiedTabsByWorktree }
        const entries: [string, NonNullable<ReturnType<typeof state.agentStatusByPaneKey.get>>][] =
          []
        for (const [index, folder] of folders.entries()) {
          if (index > 3) {
            continue
          }
          const sessionId = `polish-chat-${index}`
          const tabId = `structured-agent-session-${sessionId}`
          const workspaceId = `folder:${folder.id}`
          unified[workspaceId] = [
            {
              id: tabId,
              entityId: sessionId,
              worktreeId: workspaceId,
              groupId: 'polish-chat-group',
              contentType: 'agent-session',
              agentSessionAgent: 'claude',
              label: 'Chat',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
          entries.push([
            panes[index]!,
            {
              paneKey: panes[index]!,
              worktreeId: workspaceId,
              agentType: 'claude',
              state: index < 2 ? 'waiting' : 'working',
              stateStartedAt: Date.now(),
              updatedAt: Date.now(),
              prompt: 'Review the release',
              lastAssistantMessage: 'Checking the release work',
              stateHistory: [],
              structuredHostOwned: true
            }
          ])
        }
        window.__store!.setState({
          unifiedTabsByWorktree: unified,
          agentStatusByPaneKey: state.agentStatusByPaneKey.replace(entries),
          agentStatusEpoch: state.agentStatusEpoch + 1,
          folderWorkspaces: folders,
          collapsedGroups: new Set(),
          sidebarWidth: 280
        })
      },
      {
        folders: homes.slice(0, count),
        panes: homes
          .slice(0, count)
          .map((_, index) =>
            makePaneKey(`polish-status-${index}`, '11111111-1111-4111-8111-111111111111')
          )
      }
    )
    const toggle = page.getByRole('button', {
      name: new RegExp(`${count === 0 ? 'Bots' : 'Hide bots'}, ${count} bots`)
    })
    await expect(toggle).toBeVisible()
    if (count >= 4) {
      await expect(toggle).toHaveAttribute('aria-label', /2 need you, .*2 working/)
    }
    await expect(page.getByRole('button', { name: 'New bot', exact: true })).toBeVisible()
    await capture(page, evidence, `desktop-${count}-expanded.png`)
    if (count === 0) {
      await expect(toggle).toBeDisabled()
      await toggle.click({ force: true })
      expect(
        await page.evaluate(() => window.__store!.getState().collapsedGroups.has('bots'))
      ).toBe(false)
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await page.getByRole('button', { name: 'New bot', exact: true }).click()
      await page.getByPlaceholder('Name your bot').fill('First bot')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(
        page.locator('[data-bot-sidebar-list]').getByText('First bot', { exact: true })
      ).toBeVisible()
      await expect(page.getByRole('button', { name: /^Hide bots, 1 bots/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      await capture(page, evidence, 'desktop-first-bot-created.png')
      return
    }
    await page.locator('[data-sidebar-section="bots"] > button[aria-expanded]').click()
    const expand = page.getByRole('button', { name: new RegExp(`Show bots, ${count} bots`) })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    if (count > 5) {
      await expect(expand.getByText('+3', { exact: true })).toBeVisible()
    }
    await capture(page, evidence, `desktop-${count}-collapsed.png`)
    if (count === 8) {
      await page.evaluate(() => window.__store!.getState().setSidebarWidth(180))
      await capture(page, evidence, 'desktop-180-collapsed.png')
      await expect(page.getByRole('button', { name: 'New bot', exact: true })).toBeVisible()
      await page.evaluate(() => window.__store!.getState().setSidebarWidth(280))
      await page.locator('[data-sidebar-section="bots"] > button[aria-expanded]').click()
      const worker = await page.evaluate(() => {
        const state = window.__store!.getState()
        const worker = Object.values(state.worktreesByRepo)
          .flat()
          .find((row) => row.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary')!
        const key = `worktree:${worker.id}`
        window.__store!.setState({
          workspaceLineageByChildKey: {
            ...state.workspaceLineageByChildKey,
            [key]: {
              childWorkspaceKey: key,
              parentWorkspaceKey: 'folder:polish-home-1',
              origin: 'orchestration',
              capture: { source: 'orchestration-context', confidence: 'explicit' },
              createdAt: Date.now()
            }
          }
        })
        return worker.id
      })
      await page.getByRole('button', { name: /^Hide Triage bot/ }).click()
      await expect(
        page.locator('[data-bot-sidebar-list]').getByText('e2e-secondary', { exact: false })
      ).toHaveCount(0)
      await page.getByRole('button', { name: /^Show Triage bot/ }).click()
      await page
        .locator('[data-bot-sidebar-list]')
        .getByText('e2e-secondary', { exact: false })
        .first()
        .click()
      await expect
        .poll(() => page.evaluate(() => window.__store!.getState().activeWorktreeId))
        .toBe(worker)
      const title = page.getByText('Triage bot', { exact: false }).first()
      await title.click()
      await expect
        .poll(() => page.evaluate(() => window.__store!.getState().activeWorkspaceKey))
        .toBe('folder:polish-home-1')
      await title.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Bot settings…' }).click()
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Triage bot')
      await capture(page, evidence, 'desktop-settings-light.png')
      await page.getByText('How Triage bot works', { exact: true }).click()
      await expect(page.getByRole('textbox', { name: 'Soul', exact: true })).toBeVisible()
      await page.evaluate(async () => {
        await window.__store!.getState().updateSettings({ theme: 'dark' })
      })
      await capture(page, evidence, 'desktop-editor-dark.png')
      await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded()
      await capture(page, evidence, 'desktop-settings-dark.png')
    }
  })
}
