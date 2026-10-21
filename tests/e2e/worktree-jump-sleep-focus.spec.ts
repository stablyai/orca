import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

test('Cmd+J focuses the terminal after waking a sleeping workspace', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const source = await waitForActiveWorktree(orcaPage)
  const target = (await getAllWorktreeIds(orcaPage)).find((id) => id !== source)
  if (!target) {
    throw new Error('Expected a second seeded workspace')
  }
  await switchToWorktree(orcaPage, target)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const targetName = await orcaPage.evaluate((id) => {
    const state = window.__store!.getState()
    const worktree = state.getKnownWorktreeById(id)
    if (!worktree) {
      throw new Error('Missing target workspace')
    }
    return worktree.branch.replace(/^refs\/heads\//, '')
  }, target)
  await switchToWorktree(orcaPage, source)
  await orcaPage.evaluate(async (id) => {
    await window.__store!.getState().shutdownWorktreeTerminals(id, { keepIdentifiers: true })
  }, target)
  await orcaPage.evaluate(() => {
    const listSessions = window.api.pty.listSessions
    window.api.pty.listSessions = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return listSessions(...args)
    }
  })
  // Native menu accelerators require OS focus; open the same palette in the hidden renderer.
  await orcaPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').fill(targetName)
  await expect(dialog.locator('[cmdk-item][data-selected="true"]')).toContainText(targetName)
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 })
  await orcaPage.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const terminal = orcaPage.locator('[data-terminal-tab-id]:visible .xterm-helper-textarea').first()
  await orcaPage.screenshot({ path: testInfo.outputPath('wake-focus.png') })
  await expect(terminal).toBeFocused()
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await cdp.detach()
  await orcaPage.keyboard.type('echo WAKE_KEYBOARD_OK')
  await orcaPage.keyboard.press('Enter')
  await waitForTerminalOutput(orcaPage, 'WAKE_KEYBOARD_OK')
  await orcaPage.screenshot({ path: testInfo.outputPath('wake-typing.png') })
})
