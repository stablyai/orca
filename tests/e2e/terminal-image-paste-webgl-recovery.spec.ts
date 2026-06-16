import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const CLIPBOARD_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4AWN8z8DwnwEJMDGgAcICAO2mBAXmO4drAAAAAElFTkSuQmCC'

function imagePasteRedrawScript(marker: string): string {
  return `
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdout.write('\\x1b[?2004h')
process.stdout.write('READY_${marker}\\r\\n')

let buffered = ''
let handled = false
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8')
  if (handled || !buffered.includes('\\x1b[200~') || !buffered.includes('\\x1b[201~')) {
    return
  }
  handled = true
  for (let frame = 0; frame < 12; frame += 1) {
    process.stdout.write('\\x1b[2J\\x1b[H')
    process.stdout.write('Image accepted ${marker} frame ' + frame + '\\r\\n')
    process.stdout.write('+------------+------------+------------+\\r\\n')
    process.stdout.write('| alpha      | beta       | gamma      |\\r\\n')
    process.stdout.write('| 1234567890 | ABCDEFGHIJ | []{}<>/\\\\ |\\r\\n')
    process.stdout.write('+------------+------------+------------+\\r\\n')
  }
  process.stdout.write('DONE_${marker}\\r\\n')
})
`
}

async function forceWebgl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: {
        ...state.settings!,
        terminalGpuAcceleration: 'on'
      }
    })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    manager?.setTerminalGpuAcceleration('on')
  })
}

async function patchAtlasCounter(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const webglAddon = pane?.webglAddon
    if (!pane || !webglAddon) {
      return false
    }
    const globalWithCounter = window as typeof window & {
      __imagePasteAtlasResetCount?: number
    }
    globalWithCounter.__imagePasteAtlasResetCount = 0
    const originalClearTextureAtlas = webglAddon.clearTextureAtlas.bind(webglAddon)
    webglAddon.clearTextureAtlas = () => {
      globalWithCounter.__imagePasteAtlasResetCount =
        (globalWithCounter.__imagePasteAtlasResetCount ?? 0) + 1
      originalClearTextureAtlas()
    }
    pane.terminal.refresh(0, pane.terminal.rows - 1)
    return true
  })
}

async function readAtlasResetCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const globalWithCounter = window as typeof window & {
      __imagePasteAtlasResetCount?: number
    }
    return globalWithCounter.__imagePasteAtlasResetCount ?? 0
  })
}

test.describe('terminal image paste WebGL recovery @headful', () => {
  test('clears the WebGL atlas after a real image clipboard paste', async ({
    orcaPage,
    testRepoPath
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-image-paste-redraw-${marker}.mjs`)
    writeFileSync(scriptPath, imagePasteRedrawScript(marker))

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      await waitForTerminalOutput(orcaPage, `READY_${marker}`, 10_000)

      await forceWebgl(orcaPage)
      const webglActive = await orcaPage
        .waitForFunction(
          () => {
            const state = window.__store?.getState()
            const worktreeId = state?.activeWorktreeId
            const tabId =
              state?.activeTabType === 'terminal'
                ? state.activeTabId
                : worktreeId
                  ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
                  : null
            const manager = tabId ? window.__paneManagers?.get(tabId) : null
            const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
            return Boolean(pane?.webglAddon)
          },
          null,
          { timeout: 5_000 }
        )
        .then(() => true)
        .catch(() => false)
      test.skip(!webglActive, 'WebGL was not active in this headful environment')
      expect(await patchAtlasCounter(orcaPage)).toBe(true)

      await orcaPage.locator('.xterm-helper-textarea').first().focus()
      await orcaPage.evaluate(
        (dataUrl) => window.api.ui.writeClipboardImage(dataUrl),
        CLIPBOARD_IMAGE_DATA_URL
      )
      await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
      await waitForTerminalOutput(orcaPage, `DONE_${marker}`, 10_000)

      await expect.poll(() => readAtlasResetCount(orcaPage), { timeout: 2_000 }).toBeGreaterThan(0)
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      rmSync(scriptPath, { force: true })
    }
  })
})
