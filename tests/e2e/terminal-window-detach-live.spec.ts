import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  switchToOtherWorktree,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  execInTerminal,
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  clickTerminalTab,
  dragTerminalTabOutside,
  getTerminalTabSnapshot,
  persistActiveWorkspaceIdentity,
  positionSourceWindowForDetach,
  positionWindowsForReturn
} from './helpers/terminal-window-drag'

async function streamIndex(page: Page, token: string): Promise<number> {
  const content = await getTerminalContent(page, 40_000)
  const matches = [...content.matchAll(new RegExp(`__STREAM_${token}__:(\\d+)`, 'g'))]
  return matches.length === 0 ? -1 : Number(matches.at(-1)![1])
}

test.describe.configure({ mode: 'serial' })

test('detaches and reattaches one live terminal tab without replacing its PTY @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform !== 'darwin', 'live cursor warp uses macOS CoreGraphics')
  await waitForSessionReady(orcaPage)
  const sourceWorktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const tabId = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      return null
    }
    state.setSidebarOpen(false)
    state.setRightSidebarOpen(false)
    const tab = state.createTab(state.activeWorktreeId)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  })
  expect(tabId).not.toBeNull()
  await expect(
    orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).first()
  ).toBeVisible()
  const originalPtyId = await waitForActivePanePtyId(orcaPage, 30_000)

  const token = `detach_${Date.now()}`
  const beforeDetachMarker = `__BEFORE_DETACH__:${token}`
  await execInTerminal(
    orcaPage,
    originalPtyId,
    `export ORCA_DETACH_TOKEN=${token}; printf '__BEFORE_DETACH__:%s\\n' "$ORCA_DETACH_TOKEN"; i=0; while [ "$i" -lt 200 ]; do printf '__STREAM_${token}__:%s\\n' "$i"; i=$((i+1)); sleep 0.2; done & export ORCA_DETACH_STREAM_PID=$!`
  )
  await waitForTerminalOutput(orcaPage, beforeDetachMarker, 15_000, 40_000)
  await expect
    .poll(() => streamIndex(orcaPage, token), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)
  const streamIndexBeforeDetach = await streamIndex(orcaPage, token)

  const targetPoint = await positionSourceWindowForDetach(
    electronApp,
    (await orcaPage.evaluate(() => window.api.terminalWindow.getContext())).windowId
  )

  await dragTerminalTabOutside(electronApp, orcaPage, tabId!, targetPoint, 'right')
  await expect.poll(() => electronApp.windows().length, { timeout: 30_000 }).toBe(2)

  const windows = await Promise.all(
    electronApp.windows().map(async (page) => {
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      return { page, context: await page.evaluate(() => window.api.terminalWindow.getContext()) }
    })
  )
  const control = windows.find(({ context }) => context.role === 'control')
  const secondary = windows.find(({ context }) => context.role === 'secondary')
  expect(control).toBeTruthy()
  expect(secondary).toBeTruthy()
  await expect
    .poll(() => getTerminalTabSnapshot(control!.page, tabId!))
    .toMatchObject({ exists: false })
  await expect
    .poll(() => getTerminalTabSnapshot(secondary!.page, tabId!))
    .toMatchObject({
      exists: true,
      ptyIds: expect.arrayContaining([originalPtyId])
    })
  expect(await waitForActivePanePtyId(secondary!.page, 30_000)).toBe(originalPtyId)
  await expect
    .poll(() => streamIndex(secondary!.page, token), { timeout: 15_000 })
    .toBeGreaterThan(streamIndexBeforeDetach)
  await secondary!.page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setSidebarOpen(false)
    state?.setRightSidebarOpen(false)
  })

  const afterDetachMarker = `__AFTER_DETACH__:${token}`
  await focusActiveTerminalInput(secondary!.page)
  await secondary!.page.keyboard.type(`printf '__AFTER_DETACH__:%s\\n' "$ORCA_DETACH_TOKEN"`)
  await secondary!.page.keyboard.press('Enter')
  await expect
    .poll(() => getTerminalContent(secondary!.page), { timeout: 15_000 })
    .toContain(afterDetachMarker)

  const returnPoint = await positionWindowsForReturn(electronApp, {
    control: control!.context.windowId,
    secondary: secondary!.context.windowId
  })

  const mismatchedWorktreeId = await switchToOtherWorktree(control!.page, sourceWorktreeId)
  expect(mismatchedWorktreeId).not.toBeNull()
  await persistActiveWorkspaceIdentity(control!.page)
  await dragTerminalTabOutside(electronApp, secondary!.page, tabId!, returnPoint, 'left')
  await expect.poll(() => electronApp.windows().length).toBe(2)
  await expect(
    secondary!.page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).first()
  ).toBeVisible()
  const rollbackMarker = `__ROLLBACK__:${token}`
  await execInTerminal(
    secondary!.page,
    originalPtyId,
    `printf '__ROLLBACK__:%s\\n' "$ORCA_DETACH_TOKEN"`
  )
  await expect
    .poll(() => getTerminalContent(secondary!.page), { timeout: 15_000 })
    .toContain(rollbackMarker)

  await switchToWorktree(control!.page, sourceWorktreeId)
  await persistActiveWorkspaceIdentity(control!.page)
  await dragTerminalTabOutside(electronApp, secondary!.page, tabId!, returnPoint, 'left')
  await expect.poll(() => electronApp.windows().length, { timeout: 30_000 }).toBe(1)
  await expect
    .poll(() => getTerminalTabSnapshot(control!.page, tabId!))
    .toMatchObject({
      exists: true,
      ptyIds: expect.arrayContaining([originalPtyId])
    })
  await clickTerminalTab(control!.page, tabId!)
  expect(await waitForActivePanePtyId(control!.page, 30_000)).toBe(originalPtyId)
  await expect
    .poll(() => getTerminalContent(control!.page, 40_000), { timeout: 15_000 })
    .toContain(beforeDetachMarker)

  const afterReturnMarker = `__AFTER_RETURN__:${token}`
  await focusActiveTerminalInput(control!.page)
  await control!.page.keyboard.type(`printf '__AFTER_RETURN__:%s\\n' "$ORCA_DETACH_TOKEN"`)
  await control!.page.keyboard.press('Enter')
  await expect
    .poll(() => getTerminalContent(control!.page), { timeout: 15_000 })
    .toContain(afterReturnMarker)

  console.log(
    JSON.stringify({
      tabId,
      ptyId: originalPtyId,
      token,
      beforeDetachMarker,
      afterDetachMarker,
      rollbackMarker,
      afterReturnMarker
    })
  )
})
