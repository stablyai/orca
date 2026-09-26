import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  execInTerminal,
  sendToTerminal,
  waitForTerminalOutput
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  installTerminalPtyWriteSpy,
  clearTerminalPtyWriteLog,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

test('macOS copy falls through only for an unselected Kitty pane', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'macOS copy binding')
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const readKeyboardFlags = () =>
    orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
      type KeyboardCore = { coreService?: { kittyKeyboard?: { flags?: number } } }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm exposes its runtime core; only optional keyboard flags are inspected.
      const terminal = pane.terminal as { _core?: KeyboardCore; core?: KeyboardCore }
      return (terminal._core ?? terminal.core)?.coreService?.kittyKeyboard?.flags
    })
  const receiver = String.raw`
    process.stdin.setRawMode(true);
    let mode = -1;
    process.stdin.on("data", data => {
      if (data.length === 1 && data[0] === 4) {
        process.kill(process.pid, "SIGINT");
      } else if (data.length === 1 && data[0] === 1) {
        mode++;
        const flags = [0, 1, 3, 31][mode % 4];
        process.stdout.write("\x1b[=" + flags + "u\r\nCOPY_MODE_" + mode + "\r\n");
      } else {
        process.stdout.write("\r\nReceived: " + data.toString("hex") + "\r\n");
      }
    });
    process.stdout.write("\r\n" + "COPY_" + "READY\r\n");
  `
  await execInTerminal(orcaPage, ptyId, `node -e '${receiver.replaceAll("'", "'\\''")}'`)
  await waitForTerminalOutput(orcaPage, 'COPY_READY')
  await installTerminalPtyWriteSpy(electronApp)
  let mode = -1
  const originalClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
  try {
    for (const policy of ['orca-first', 'terminal-first'] as const) {
      await orcaPage.evaluate((terminalShortcutPolicy) => {
        window.__store!.setState((state) => {
          if (!state.settings) {
            throw new Error('Terminal settings are not loaded')
          }
          return { settings: { ...state.settings, terminalShortcutPolicy } }
        })
      }, policy)
      for (const flags of [0, 1, 3, 31]) {
        await sendToTerminal(orcaPage, ptyId, '\x01')
        await waitForTerminalOutput(orcaPage, `COPY_MODE_${++mode}`)
        await orcaPage.evaluate(() => {
          const state = window.__store!.getState()
          window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal.clearSelection()
        })
        await focusActiveTerminalInput(orcaPage)
        await clearTerminalPtyWriteLog(electronApp)
        await expect.poll(readKeyboardFlags).toBe(flags)
        // Ctrl+C may be handled by the running app without exiting.
        await orcaPage
          .locator('.xterm-helper-textarea')
          .first()
          .evaluate((textarea) => {
            for (const type of ['keydown', 'keyup']) {
              textarea.dispatchEvent(
                new KeyboardEvent(type, {
                  key: 'c',
                  code: 'KeyC',
                  ctrlKey: true,
                  keyCode: 67,
                  bubbles: true,
                  cancelable: true
                })
              )
            }
          })
        await expect.poll(() => readTerminalPtyWrites(electronApp)).toEqual(['\x03'])
        await waitForTerminalOutput(orcaPage, 'Received: 03')
        await clearTerminalPtyWriteLog(electronApp)
        await orcaPage.keyboard.press('Meta+c')
        const press = flags === 31 ? '\x1b[99;9;99u' : '\x1b[99;9u'
        const expected = flags === 0 ? [] : flags === 1 ? [press] : [press, '\x1b[99;9:3u']
        await expect.poll(() => readTerminalPtyWrites(electronApp)).toEqual(expected)
      }
    }

    for (const remapped of [false, true]) {
      await orcaPage.evaluate((remapped) => {
        window.__store!.setState({
          keybindings: { 'terminal.copySelection': [remapped ? 'Mod+Shift+C' : 'Mod+C'] }
        })
      }, remapped)
      const selectedText = await orcaPage.evaluate(async () => {
        const state = window.__store!.getState()
        const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
        await new Promise<void>((resolve) =>
          pane.terminal.write('\r\nTerminal copy selection\r\n', resolve)
        )
        const buffer = pane.terminal.buffer.active
        pane.terminal.select(0, buffer.baseY + buffer.cursorY - 1, 23)
        return pane.terminal.getSelection()
      })
      expect(selectedText).toBe('Terminal copy selection')
      await clearTerminalPtyWriteLog(electronApp)
      await orcaPage.keyboard.down('Meta')
      if (remapped) {
        await orcaPage.keyboard.down('Shift')
      }
      await orcaPage.keyboard.down('c')
      await orcaPage.keyboard.down('c')
      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(selectedText)
      // A selection can disappear between the claimed press and its release.
      await orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal.clearSelection()
      })
      if (remapped) {
        await orcaPage.keyboard.up('Shift')
      }
      await orcaPage.keyboard.up('Meta')
      await orcaPage.keyboard.up('c')
      expect(await readTerminalPtyWrites(electronApp)).toEqual([])
    }
    // Leave keyboard reporting armed and die without running application cleanup.
    await sendToTerminal(orcaPage, ptyId, '\x04')
    await expect.poll(readKeyboardFlags).toBe(0)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type('echo "SHELL_""RECOVERED"')
    await orcaPage.keyboard.press('Enter')
    await waitForTerminalOutput(orcaPage, 'SHELL_RECOVERED')
    await expect(orcaPage.locator('.xterm-screen').first()).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('terminal-copy.png') })
  } finally {
    await electronApp.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      originalClipboard
    )
  }
})
