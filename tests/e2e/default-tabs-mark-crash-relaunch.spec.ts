// Crash before debounced saves or terminal starts can persist default-tab marks; relaunch must not apply the defaults again.

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)
const TEMPLATES = [{ title: 'p6-default-a' }, { title: 'p6-default-b' }]
const TITLES = TEMPLATES.map((template) => template.title)

type DefaultTabs = { tabs: { title: string }[]; runCommands: false }

async function withholdSavesAndTerminalStarts(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ['session:set', 'session:patch']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => undefined)
    }
    ipcMain.removeHandler('pty:spawn')
    ipcMain.handle('pty:spawn', () => new Promise(() => {}))
  })
}

async function activateWithDefaultTabs(
  app: ElectronApplication,
  repoId: string,
  worktreeId: string,
  defaultTabs: DefaultTabs
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('ui:activateWorktree', payload)
      }
    },
    { repoId, worktreeId, defaultTabs }
  )
}

async function crash(app: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
  app.process().kill('SIGKILL')
  await exited
}

async function workspaceTabs(page: Page, worktreeId: string) {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    return {
      marked: state.defaultTerminalTabsAppliedByWorktreeId[id] === true,
      tabs: (state.tabsByWorktree[id] ?? []).map((tab) => ({
        title: tab.customTitle ?? null,
        ptyId: tab.ptyId ?? null
      }))
    }
  }, worktreeId)
}

async function createUnopenedWorktree(page: Page, name: string) {
  return page.evaluate(async (worktreeName) => {
    const state = window.__store!.getState()
    const repoId = state.allWorktrees()[0]?.repoId
    if (!repoId) {
      throw new Error('seed repo was not loaded')
    }
    const created = await state.createWorktree(repoId, worktreeName, undefined, 'skip')
    return { repoId, worktreeId: created.worktree.id }
  }, name)
}

async function waitForWorktree(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            window
              .__store!.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id),
          worktreeId
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function crashThenOfferTemplates(
  testRepoPath: string,
  testInfo: Parameters<typeof createRestartSession>[0],
  first: DefaultTabs
) {
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | undefined
  try {
    const launched = await session.launch()
    app = launched.app
    await waitForSessionReady(launched.page)
    await attachRepoAndOpenTerminal(launched.page, testRepoPath)
    const { repoId, worktreeId } = await createUnopenedWorktree(
      launched.page,
      `p6-default-tabs-${Date.now()}`
    )
    expect((await workspaceTabs(launched.page, worktreeId)).marked).toBe(false)

    await withholdSavesAndTerminalStarts(app)
    await activateWithDefaultTabs(app, repoId, worktreeId, first)
    await expect
      .poll(async () => (await workspaceTabs(launched.page, worktreeId)).marked, {
        timeout: 15_000
      })
      .toBe(true)
    // Long enough for a command to main to land; no window save or terminal start can.
    await launched.page.waitForTimeout(1_500)
    const beforeCrash = await workspaceTabs(launched.page, worktreeId)
    expect(beforeCrash.tabs.every((tab) => tab.ptyId === null)).toBe(true)
    await crash(app)
    app = undefined

    const relaunched = await session.launch()
    app = relaunched.app
    await waitForSessionReady(relaunched.page)
    await waitForWorktree(relaunched.page, worktreeId)
    const restored = await workspaceTabs(relaunched.page, worktreeId)
    await activateWithDefaultTabs(app, repoId, worktreeId, { tabs: TEMPLATES, runCommands: false })
    await expect
      .poll(() => relaunched.page.evaluate(() => window.__store!.getState().activeWorktreeId), {
        timeout: 15_000
      })
      .toBe(worktreeId)
    await relaunched.page.waitForTimeout(2_000)
    return { beforeCrash, restored, after: await workspaceTabs(relaunched.page, worktreeId) }
  } finally {
    await session.dispose(app)
  }
}

const countTitled = (tabs: { title: string | null }[], title: string) =>
  tabs.filter((tab) => tab.title === title).length

test.describe('default tabs across a crash before the first terminal start', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'layout-owner build only')
  test.skip(process.platform === 'win32', 'Uses POSIX SIGKILL to simulate a crash')

  test('a workspace that had no default tabs does not get ones added later', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(240_000)
    const { restored, after } = await crashThenOfferTemplates(testRepoPath, testInfo, {
      tabs: [],
      runCommands: false
    })

    expect(restored.marked, 'the relaunch remembers the default tabs were applied').toBe(true)
    for (const title of TITLES) {
      expect(countTitled(after.tabs, title), `tabs titled ${title}`).toBe(0)
    }
  })

  test('a workspace’s default tabs are not applied twice', async ({ testRepoPath }, testInfo) => {
    test.setTimeout(240_000)
    const { beforeCrash, restored, after } = await crashThenOfferTemplates(testRepoPath, testInfo, {
      tabs: TEMPLATES,
      runCommands: false
    })

    for (const title of TITLES) {
      expect(countTitled(beforeCrash.tabs, title), `tabs titled ${title} before the crash`).toBe(1)
    }
    expect(restored.marked, 'the relaunch remembers the default tabs were applied').toBe(true)
    for (const title of TITLES) {
      expect(countTitled(after.tabs, title), `tabs titled ${title}`).toBe(1)
    }
  })
})
