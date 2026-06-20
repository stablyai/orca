import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  focusLastTerminalPane,
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'

function keyboardPasteChord(): string {
  return process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
}

function pasteEchoScript(runId: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdout.write('SPLIT_PASTE_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  seq += 1
  const encoded = Buffer.from(chunk, 'utf8').toString('base64')
  process.stdout.write('SPLIT_PASTE_CHUNK_${runId}_' + seq + ':' + encoded + '\\n')
})
`
}

function countOccurrences(value: string, needle: string): number {
  let count = 0
  let index = value.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = value.indexOf(needle, index + needle.length)
  }
  return count
}

test.describe('split terminal pane paste ownership', () => {
  test('keyboard paste writes only to the active split pane PTY', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await focusLastTerminalPane(orcaPage)

    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const activePane = snapshot.panes.find((pane) => pane.leafId === snapshot.activeLeafId)
    const inactivePane = snapshot.panes.find((pane) => pane.leafId !== snapshot.activeLeafId)
    if (!activePane?.ptyId || !inactivePane?.ptyId) {
      throw new Error('Split terminal panes did not expose active and inactive PTY ids')
    }

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-split-paste-${runId}.mjs`)
    writeFileSync(scriptPath, pasteEchoScript(runId))
    let scriptStarted = false

    try {
      await sendToTerminal(orcaPage, activePane.ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `SPLIT_PASTE_READY_${runId}`, 10_000)

      const payload = `ORCA_E2E_SPLIT_PASTE_${runId}`
      const encodedPayload = Buffer.from(payload, 'utf8').toString('base64')
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await clearTerminalPtyWriteLog(electronApp)
      await focusActiveTerminalInput(orcaPage)

      await orcaPage.keyboard.press(keyboardPasteChord())
      await waitForTerminalOutput(orcaPage, encodedPayload, 10_000, 12_000)

      const writes = await readTerminalPtyWriteEntries(electronApp)
      const activeWrites = writes
        .filter((entry) => entry.id === activePane.ptyId)
        .map((entry) => entry.data)
        .join('')
      const inactiveWrites = writes
        .filter((entry) => entry.id === inactivePane.ptyId)
        .map((entry) => entry.data)
        .join('')
      expect(countOccurrences(activeWrites, payload)).toBe(1)
      expect(inactiveWrites).not.toContain(payload)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, activePane.ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })

  test('internal file drop writes only to the pane under the drop target', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await focusLastTerminalPane(orcaPage)

    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const activePane = snapshot.panes.find((pane) => pane.leafId === snapshot.activeLeafId)
    const dropPane = snapshot.panes.find((pane) => pane.leafId !== snapshot.activeLeafId)
    if (!activePane?.ptyId || !dropPane?.ptyId) {
      throw new Error('Split terminal panes did not expose active and drop-target PTY ids')
    }

    const runId = randomUUID()
    const dropPath = path.join(testRepoPath, `drop-target-${runId}.txt`)
    const dropMarker = path.basename(dropPath)

    await clearTerminalPtyWriteLog(electronApp)
    await orcaPage.evaluate(
      ({ leafId, pathValue }) => {
        const state = window.__store?.getState()
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : state?.activeWorktreeId
              ? (state.activeTabIdByWorktree?.[state.activeWorktreeId] ?? null)
              : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getPanes?.().find((candidate) => candidate.leafId === leafId)
        if (!pane) {
          throw new Error('Drop target pane not found')
        }
        const dataTransfer = new DataTransfer()
        dataTransfer.setData('text/x-orca-file-path', pathValue)
        const target = pane.container.querySelector('.xterm-screen, textarea') ?? pane.container
        for (const eventType of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(
            new DragEvent(eventType, {
              bubbles: true,
              cancelable: true,
              dataTransfer
            })
          )
        }
      },
      { leafId: dropPane.leafId, pathValue: dropPath }
    )

    await expect
      .poll(
        async () => {
          const writes = await readTerminalPtyWriteEntries(electronApp)
          return writes.some(
            (entry) => entry.id === dropPane.ptyId && entry.data.includes(dropMarker)
          )
        },
        { timeout: 10_000, message: 'Internal file drop did not write to the drop-target PTY' }
      )
      .toBe(true)

    const writes = await readTerminalPtyWriteEntries(electronApp)
    const activeWrites = writes
      .filter((entry) => entry.id === activePane.ptyId)
      .map((entry) => entry.data)
      .join('')
    const dropWrites = writes
      .filter((entry) => entry.id === dropPane.ptyId)
      .map((entry) => entry.data)
      .join('')
    expect(dropWrites).toContain(dropMarker)
    expect(activeWrites).not.toContain(dropMarker)
  })
})
