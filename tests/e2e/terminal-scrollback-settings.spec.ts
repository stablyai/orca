import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree
} from './helpers/store'
import {
  waitForActiveTerminalManager,
  waitForActivePanePtyId,
  sendToTerminal,
  getTerminalContent
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { scrollActiveTerminalToText } from './artificial-opencode-active-terminal-scroll'

test('100k setting retains early output after hiding and revealing the terminal', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(120000)
  await waitForSessionReady(orcaPage)
  const first = await waitForActiveWorktree(orcaPage)
  const second = (await getAllWorktreeIds(orcaPage)).find((id) => id !== first)
  expect(second).toBeTruthy()
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({ uiLanguage: 'en' })
    state.markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    state.openSettingsPage()
  })
  await orcaPage.getByPlaceholder('Search settings').fill('scrollback')
  const preset = orcaPage.getByRole('radio', { name: '100000 rows', exact: true })
  await expect(preset).toBeVisible()
  await preset.click()
  await expect(preset).toHaveAttribute('data-state', 'on')
  await orcaPage.screenshot({ path: testInfo.outputPath('100k-settings.png') })
  await orcaPage.setViewportSize({ width: 760, height: 820 })
  for (const theme of ['light', 'dark'] as const) {
    await orcaPage.evaluate((theme) => window.__store!.getState().updateSettings({ theme }), theme)
    await preset.scrollIntoViewIfNeeded()
    await expect(preset).toBeVisible()
    await expect(preset).toHaveAttribute('data-state', 'on')
    await orcaPage.screenshot({ path: testInfo.outputPath(`100k-settings-narrow-${theme}.png`) })
  }
  await orcaPage.setViewportSize({ width: 1280, height: 820 })
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const script = path.join(testRepoPath, '.orca-scrollback-fixture.cjs')
  writeFileSync(
    script,
    "let i=0; const timer=setInterval(()=>{let s='';for(let j=0;j<500&&i<75000;j++,i++)s+='SCROLLBACK_ROW_'+i+'\\r\\n';process.stdout.write(s);if(i===75000){clearInterval(timer);process.stdout.write('SCROLLBACK_COMPLETE\\r\\n')}},10)"
  )
  try {
    await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([script])}\r`)
    await expect
      .poll(() => getTerminalContent(orcaPage, 100), { timeout: 30000 })
      .toContain('SCROLLBACK_COMPLETE')
    const diagnostics = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
      const buffer = pane.terminal.buffer.normal
      return {
        configured: state.settings.terminalScrollbackRows,
        applied: pane.terminal.options.scrollback,
        rows: buffer.length,
        first: Array.from({ length: 10 }, (_, i) => buffer.getLine(i)?.translateToString(true)),
        tab: state.activeTabId,
        type: state.activeTabType,
        mapped: state.activeTabIdByWorktree[state.activeWorktreeId!]
      }
    })
    await testInfo.attach('scrollback-before-switch', {
      body: JSON.stringify(diagnostics),
      contentType: 'application/json'
    })
    await scrollActiveTerminalToText(orcaPage, 'SCROLLBACK_ROW_0')
    await switchToWorktree(orcaPage, second!)
    await waitForActiveTerminalManager(orcaPage)
    await switchToWorktree(orcaPage, first)
    await waitForActiveTerminalManager(orcaPage)
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const manager = window.__paneManagers!.get(state.activeTabId!)!
      const pane = manager.getActivePane()!
      pane.terminal.options.screenReaderMode = true
    })
    await expect(async () => {
      await scrollActiveTerminalToText(orcaPage, 'SCROLLBACK_ROW_0')
    }).toPass({ timeout: 15000 })
    await expect(orcaPage.locator('.xterm-accessibility-tree')).toContainText('SCROLLBACK_ROW_0')
    const selection = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
      const found = pane.searchAddon.findNext('SCROLLBACK_ROW_0', { wholeWord: true })
      return { found, text: pane.terminal.getSelection() }
    })
    expect(selection).toEqual({ found: true, text: 'SCROLLBACK_ROW_0' })

    await orcaPage.screenshot({ path: testInfo.outputPath('100k-restored-earliest-row.png') })
  } finally {
    rmSync(script, { force: true })
  }
})
