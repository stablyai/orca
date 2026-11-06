import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const EXPECTED = [
  'hello world  from Orca',
  '안녕하세요 오르카  사용자입니다',
  'Orca 터미널  copy context',
  'key     value   한국어',
  'CONTEXT_SPACING_READY'
].join('\n')

for (const mode of ['normal', 'alternate'] as const) {
  test(`terminal Copy Context preserves visible word and tab gaps in ${mode} buffer`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await focusActiveTerminalInput(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await retryTransientMainEvaluate(() =>
      electronApp.evaluate(({ ipcMain }) => {
        // Capture the real menu's output at the IPC boundary without touching the OS clipboard.
        ipcMain.removeHandler('clipboard:writeTerminalText')
        ipcMain.handle('clipboard:writeTerminalText', (_event, text: string) => {
          process.env.ORCA_E2E_COPY_CONTEXT_RESULT = text
        })
      })
    )
    const fixture = await runNodeScriptInTerminal(
      orcaPage,
      ptyId,
      [
        "process.stdout.write('\\x1b[3J\\x1b[2J\\x1b[H' +",
        `${JSON.stringify(mode === 'alternate' ? 'Retained normal context\r\n\x1b[?1049h\x1b[H' : '')} +`,
        "'hello\\x1b[1Cworld\\x1b[2Cfrom Orca\\r\\n' +",
        "'안녕하세요\\x1b[1C오르카\\x1b[2C사용자입니다\\r\\n' +",
        "'Orca\\x1b[1C터미널\\x1b[2Ccopy context\\r\\n' +",
        "'key\\tvalue\\t한국어\\r\\n' +",
        "'CONTEXT_SPACING_READY'); process.stdin.resume()"
      ].join('\n')
    )
    try {
      await expect
        .poll(() => getTerminalContent(orcaPage, 10_000))
        .toContain('CONTEXT_SPACING_READY')
      fixture.cleanup()
      await orcaPage.evaluate(() => {
        const tabId = window.__store?.getState().activeTabId
        const manager = tabId ? window.__paneManagers?.get(tabId) : undefined
        const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
        if (!pane) {
          throw new Error('Active terminal pane unavailable')
        }
        pane.container.dataset.copyContextSpacingProbe = 'true'
      })
      const terminal = orcaPage.locator('[data-copy-context-spacing-probe="true"] .xterm-screen')
      await terminal.click({ button: 'right', position: { x: 30, y: 30 } })
      const copy = orcaPage.getByRole('menuitem', { name: /^(Copy Context|컨텍스트 복사)$/ })
      await expect(copy).toBeVisible()
      const cdp = await orcaPage.context().newCDPSession(orcaPage)
      try {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
        await writeFile(testInfo.outputPath('copy-context-menu.png'), Buffer.from(data, 'base64'))
      } finally {
        await cdp.detach()
      }
      await copy.click()
      const readCopiedText = (): Promise<string | null> =>
        electronApp.evaluate(() => process.env.ORCA_E2E_COPY_CONTEXT_RESULT ?? null)
      await expect.poll(readCopiedText).not.toBeNull()
      const actual = await readCopiedText()
      await testInfo.attach('copied-context', {
        body: actual ?? '<no clipboard IPC received>',
        contentType: 'text/plain'
      })
      expect(actual).toBe(mode === 'alternate' ? `Retained normal context\n${EXPECTED}` : EXPECTED)
    } finally {
      fixture.cleanup()
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
}
