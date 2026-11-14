import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sendToTerminal } from './helpers/terminal'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

// Mirror FLOATING_TERMINAL_WORKTREE_ID without loading renderer/shared modules into Playwright.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'

const readLog = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const ptyOf = (page: Page, tabId: string | null): Promise<string | null> =>
  page.evaluate((id) => window.__store?.getState().ptyIdsByTabId[id ?? '']?.[0] ?? null, tabId)
const winchCount = (file: string): number =>
  readLog(file).filter((l) => l.startsWith('winch')).length
const lastSize = (file: string): string | undefined =>
  readLog(file).findLast((l) => l.startsWith('size'))
// ast-grep-ignore: test-no-real-time-wait -- a SIGWINCH or stdin line that must not happen has no event to wait on
const settle = (page: Page): Promise<void> => page.waitForTimeout(1_000)
const panelOpen = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => window.__store?.getState().floatingWorkspacePanelOpen)

// Logs its grid at start and on every SIGWINCH; logs each stdin line; answers SIZE with its grid; EXIT leaves the PTY idle.
function probeCommand(logPath: string): string {
  const source = [
    "const fs=require('node:fs')",
    `const log=(s)=>fs.appendFileSync(${JSON.stringify(logPath)},s+'\\n')`,
    "const size=()=>process.stdout.columns+'x'+process.stdout.rows",
    "log('start '+size())",
    "process.on('SIGWINCH',()=>log('winch '+size()))",
    "require('node:readline').createInterface({input:process.stdin,terminal:false}).on('line',(l)=>l==='EXIT'?process.exit(0):log(l==='SIZE'?'size '+size():'line '+l))",
    'setInterval(()=>{},1000)'
  ].join(';')
  return stageNodeScriptForTerminal(source, { prefix: 'orca-floating-window-probe' }).command
}

async function startProbe(page: Page, ptyId: string, logPath: string): Promise<void> {
  mkdirSync(path.dirname(logPath), { recursive: true })
  writeFileSync(logPath, '')
  await sendToTerminal(page, ptyId, `${probeCommand(logPath)}\r`)
  await expect.poll(() => readLog(logPath)[0]).toMatch(/^start /)
}

async function floatingWindowIds(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => win.webContents.getURL().includes('surface=floating-workspace'))
      .map((win) => win.webContents.id)
  )
}

async function expectNoVisibleOrFocusedWindow(app: ElectronApplication): Promise<void> {
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      visible: win.isVisible(),
      focused: win.isFocused()
    }))
  )
  expect(windows.every((win) => !win.visible && !win.focused)).toBe(true)
}

async function enablePopout(page: Page, mode: 'in-window' | 'popout'): Promise<void> {
  await page.evaluate(async (mode) => {
    await window.__store?.getState().updateSettings({
      floatingTerminalEnabled: true,
      experimentalFloatingWorkspacePopout: true,
      experimentalFloatingWorkspaceMode: mode
    })
  }, mode)
}

async function setPanelOpen(page: Page, open: boolean): Promise<void> {
  await page.evaluate(
    (open) => window.__store?.getState().setFloatingWorkspacePanelOpen(open),
    open
  )
}

async function expectQuitWithin15s(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await expect
    .poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: 15_000 })
    .toBe(true)
}

test.describe('Floating workspace pop-out window', () => {
  test('opens, types, survives toggles and docks back to the in-window grid', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    // Why: one launch drives two PTYs, a pop-out window, five toggles, a dock and a quit.
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const mainTabId = await orcaPage.evaluate(() => window.__store?.getState().activeTabId ?? null)
    await expect.poll(() => ptyOf(orcaPage, mainTabId)).not.toBeNull()
    const mainPty = (await ptyOf(orcaPage, mainTabId))!
    const mainLog = path.join(testInfo.outputDir, 'main-probe.log')
    const floatLog = path.join(testInfo.outputDir, 'floating-probe.log')
    await startProbe(orcaPage, mainPty, mainLog)

    await enablePopout(orcaPage, 'in-window')
    const floatingTabId = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { activate: false })
      state.setActiveTabForWorktree(worktreeId, tab.id)
      state.activateTab(tab.id)
      state.setFloatingWorkspacePanelOpen(true)
      return tab.id
    }, FLOATING_WORKTREE_ID)
    await expect.poll(() => ptyOf(orcaPage, floatingTabId)).not.toBeNull()
    const floatingPty = (await ptyOf(orcaPage, floatingTabId))!
    await startProbe(orcaPage, floatingPty, floatLog)

    const opened = electronApp.waitForEvent('window')
    await enablePopout(orcaPage, 'popout')
    const floatPage = await opened
    const [windowId] = await floatingWindowIds(electronApp)
    await expect(floatPage.locator('.xterm')).toBeVisible()
    await expectNoVisibleOrFocusedWindow(electronApp)

    await sendToTerminal(orcaPage, floatingPty, 'SIZE\r')
    await expect.poll(() => lastSize(floatLog)).toBeDefined()
    const [cols, rows] = lastSize(floatLog)!.slice(5).split('x').map(Number)
    expect(cols).toBeGreaterThanOrEqual(80)
    expect(rows).toBeGreaterThanOrEqual(24)

    // A7: the first replay focuses the window's terminal, so typing needs no click.
    await floatPage.keyboard.type('marker-one')
    await floatPage.keyboard.press('Enter')
    await expect.poll(() => readLog(floatLog)).toContain('line marker-one')
    await floatPage.keyboard.type('foo bar')
    await floatPage.keyboard.press('Control+w')
    await floatPage.keyboard.type('baz')
    await floatPage.keyboard.press('Enter')
    await expect.poll(() => readLog(floatLog)).toContain('line foo baz')
    expect(floatPage.isClosed()).toBe(false)

    // D2: the window cannot type into a PTY its snapshot does not name; the main window's own path can.
    const probeMarker = 'cross-window-marker'
    await floatPage.evaluate(
      ({ ptyId, data }) => window.api.terminalPreview.input(ptyId, data).catch(() => undefined),
      { ptyId: mainPty, data: `${probeMarker}\r` }
    )
    await settle(floatPage)
    expect(readLog(mainLog)).not.toContain(`line ${probeMarker}`)
    await sendToTerminal(orcaPage, mainPty, `${probeMarker}\r`)
    await expect.poll(() => readLog(mainLog)).toContain(`line ${probeMarker}`)

    // D3: five hide/show toggles keep the window and add no SIGWINCH.
    await settle(floatPage)
    const winchBefore = winchCount(floatLog)
    for (let i = 0; i < 5; i += 1) {
      await orcaPage.evaluate((event) => window.dispatchEvent(new Event(event)), TOGGLE_EVENT)
      await expect.poll(() => panelOpen(orcaPage)).toBe(false)
      await orcaPage.evaluate((event) => window.dispatchEvent(new Event(event)), TOGGLE_EVENT)
      await expect.poll(() => panelOpen(orcaPage)).toBe(true)
    }
    await settle(floatPage)
    expect(winchCount(floatLog)).toBe(winchBefore)
    expect(await floatingWindowIds(electronApp)).toEqual([windowId])
    await expectNoVisibleOrFocusedWindow(electronApp)

    // D4: dock adds at most one SIGWINCH and ends at the in-window pane's grid.
    await floatPage.getByRole('button', { name: 'Dock' }).click()
    await expect.poll(() => floatingWindowIds(electronApp)).toEqual([])
    await settle(orcaPage)
    expect(winchCount(floatLog) - winchBefore).toBeLessThanOrEqual(1)
    await sendToTerminal(orcaPage, floatingPty, 'SIZE\r')
    const paneGrid = await orcaPage.evaluate((id) => {
      const terminal = window.__paneManagers?.get(id)?.getPanes()[0]?.terminal
      return `${terminal?.cols}x${terminal?.rows}`
    }, floatingTabId)
    await expect.poll(() => lastSize(floatLog)).toBe(`size ${paneGrid}`)
    await expectNoVisibleOrFocusedWindow(electronApp)

    // D7: a quit with the window shown ends the process; the probes exit first so no running-process prompt blocks it.
    await sendToTerminal(orcaPage, floatingPty, 'EXIT\r')
    await sendToTerminal(orcaPage, mainPty, 'EXIT\r')
    const reopened = electronApp.waitForEvent('window')
    await enablePopout(orcaPage, 'popout')
    await reopened
    await expectQuitWithin15s(electronApp)
  })

  test('a cancelled quit leaves the window usable, a later close hides it, and quit still ends', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    // Why: two quit attempts around a save-prompt cancel.
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await enablePopout(orcaPage, 'popout')
    const opened = electronApp.waitForEvent('window')
    await setPanelOpen(orcaPage, true)
    await opened
    const ids = await floatingWindowIds(electronApp)
    await orcaPage.evaluate(
      (filePath) => {
        const state = window.__store!.getState()
        const fileId = state.openFile({
          filePath,
          relativePath: 'quit-cancel-draft.txt',
          worktreeId: state.activeWorktreeId ?? '',
          language: 'plaintext',
          mode: 'edit'
        })
        state.setEditorDraft(fileId, 'unsaved draft')
        state.markFileDirty(fileId, true)
      },
      path.join(testRepoPath, 'quit-cancel-draft.txt')
    )

    await electronApp.evaluate(({ app }) => app.quit())
    const dialog = orcaPage.getByRole('dialog').filter({ hasText: 'unsaved changes' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(await floatingWindowIds(electronApp)).toEqual(ids)

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes('surface=floating-workspace'))
        ?.close()
    })
    await expect.poll(() => panelOpen(orcaPage)).toBe(false)
    expect(await floatingWindowIds(electronApp)).toEqual(ids)

    // D7: a quit with the window hidden ends the process.
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openFiles.forEach((file) => state.markFileDirty(file.id, false))
    })
    await expectQuitWithin15s(electronApp)
  })
})
