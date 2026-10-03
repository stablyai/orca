import type { Page } from '@stablyai/playwright-test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

// Controlled PTY recorder, not a Codex process or a model-ingestion test.
const recorder = `
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\\x1b[?2004hREADY_IMAGE_TRAY\\r\\n')
let count = 0
let buffer = ''
process.stdin.on('data', bytes => {
  buffer += bytes.toString()
  if (buffer.includes('\\x03')) process.exit(0)
  while (buffer.includes('\\x1b[201~')) {
    const end = buffer.indexOf('\\x1b[201~')
    const framed = buffer.slice(0, end)
    buffer = buffer.slice(end + 6)
    if (framed.includes('.png')) count++
    process.stdout.write('IMAGE_INPUT_COUNT=' + count + '\\r\\n')
  }
})
`

async function setCodexAuthority(page: Page, enabled: boolean) {
  await page.evaluate((enabled) => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
    if (!state || !tabId || !pane) {
      throw new Error('No test pane')
    }
    state.setPaneForegroundAgent(`${tabId}:${pane.leafId}`, {
      agent: enabled ? 'codex' : null,
      shellForeground: !enabled,
      routingTrusted: enabled
    })
  }, enabled)
}

test('stages, previews, removes, cancels and explicitly adds clipboard images', async ({
  orcaPage: page,
  electronApp,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  const script = path.join(testRepoPath, 'image-tray-recorder.cjs')
  const png = path.join(testRepoPath, 'test-image.png')
  writeFileSync(script, recorder)
  writeFileSync(
    png,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAWgAAAC0CAYAAAC5brY1AAAEMUlEQVR4nO3UMVEEAQAEwZeDiBdBjCaUvAhEoITkYjBARlGz99dB5xtsze04jm8A9tzqAQD8TqABRgk0wCiBBhgl0ACjBBpglEADjBJogFECDTBKoAFGCTTAKIEGGCXQAKMEGmCUQAOMEmiAUQINMEqgAUYJNMAogQYY9S+B/vq4A1yOQAOMEmiAUQINMEqgAUYJNMAogQYYJdAAowQaYJRAA4wSaIBRAg0wSqABRgk0wCiBBhgl0ACjBBpglEADjBJogFECDTBKoAFGCTTAKIEGGCXQAKNOEWgA/k6gAUYJNMAogQYYJdAAowQaYJRAA4wSaIBRAg0wSqABRgk0wCiBBhgl0ACjBBpglEADjBJogFECDTBKoAFGCTTAKIEGGCXQAKNOEeiXt0+eVPmr18c7F1e3TaCZJtCU6rYJNNMEmlLdNoFmmkBTqtsm0EwTaEp12wSaaQJNqW6bQDNNoCnVbRNopgk0pbptAs00gaZUt02gmSbQlOq2CTTTBJpS3TaBZppAU6rbJtBME2hKddsEmmkCTalum0AzTaAp1W0TaKYJNKW6bQLNNIGmVLdNoJkm0JTqtgk00wSaUt02gWaaQFOq2ybQTBNoSnXbBJppAk2pbptAM02gKdVtE2imCTSlum0CzTSBplS3TaCZJtCU6rYJNNMEmlLdNoFmmkBTqtsm0EwTaEp12wSaaQJNqW6bQDNNoCnVbRNopgk0pbptAs00gaZUt02gmSbQlOq2CTTTBJpS3TaBZppAU6rbJtBME2hKddsEmmkCTalum0AzTaAp1W0TaKYJNKW6bQLNNIGmVLdNoJkm0JTqtgk00wSaUt02gWaaQFOq2ybQTBNoSnXbBJppAk2pbptAM02gKdVtE2imCTSlum0CzTSBplS3TaCZJtCU6rYJNNMEmlLdNoFmmkBTqtsm0EwTaEp12wSaaQJNqW6bQDNNoCnVbRNopgk0pbptAs00gaZUt02gmSbQlOq2CTTTBJpS3TaBZppAU6rbJtBME2hKddsEmmkCTalum0AzTaAp1W0TaKYJNKW6bQLNNIGmVLdNoJkm0JTqtgk00wSaUt02gWaaQFOq2ybQTBNoSnXbBJppAk2pbptAM02gKdVtE2imCTSlum0CzTSBplS3TaCZJtCU6rYJNNMEmlLdNoFmmkBTqtsm0EwTaEp12wSaaQJNqW6bQDNNoCnVbRNopgk0pbptAs00gaZUt02gmSbQlOq2CTTTBJpS3TaBZppAU6rbJtBME2hKddsEmmkCTalum0AzTaAp1W0TaKYJNKW6bQLNNIGmVLftKQINcEUCDTBKoAFGCTTAKIEGGCXQAKMEGmCUQAOMEmiAUQINMEqgAUYJNMAogQYYJdAAowQaYJRAA4wSaIBRAg0wSqABRgk0wCiBBhgl0ACjBBpglEADjBJogFE/PwMtGdbtVHsAAAAASUVORK5CYII=',
      'base64'
    )
  )
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(script)}\r`)
  await waitForTerminalOutput(page, 'READY_IMAGE_TRAY', 10_000)
  const dataUrl = `data:image/png;base64,${readFileSync(png).toString('base64')}`
  await electronApp.evaluate(
    ({ ipcMain }, { png, dataUrl }) => {
      ipcMain.removeHandler('clipboard:readText')
      ipcMain.handle('clipboard:readText', () => '')
      ipcMain.removeHandler('clipboard:saveImagePreview')
      ipcMain.handle('clipboard:saveImagePreview', () => ({ path: png, dataUrl }))
      ipcMain.removeHandler('clipboard:imageLease')
      const settlements: unknown[] = []
      Reflect.set(globalThis, 'orcaImagePreviewTestSettlements', settlements)
      ipcMain.handle('clipboard:imageLease', (_event, args) => {
        settlements.push(args)
      })
    },
    { png, dataUrl }
  )
  await setCodexAuthority(page, true)
  const tray = page.locator('[data-terminal-image-attachments]')
  const paste = async () => {
    await page.locator('.xterm-helper-textarea').first().focus()
    await page.locator('.xterm-helper-textarea').first().dispatchEvent('paste')
    await expect(tray).toBeVisible()
  }
  await paste()
  await expect(tray.locator('img')).toBeVisible()
  await tray.screenshot({ path: testInfo.outputPath('image-tray-preview.png') })
  await tray.getByRole('button', { name: 'Cancel', exact: true }).focus()
  const menuIgnored = await page.evaluate(() => {
    const event = new CustomEvent('orca-app-menu-paste', { cancelable: true, bubbles: true })
    window.dispatchEvent(event)
    return !event.defaultPrevented
  })
  expect(menuIgnored).toBe(true)
  await expect(tray).toBeVisible()

  await tray.getByRole('button', { name: 'View image: test-image.png' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page
    .getByRole('dialog')
    .screenshot({ path: testInfo.outputPath('image-tray-full-size.png') })
  await page.keyboard.press('Escape')
  await tray.getByRole('button', { name: 'Remove attachment' }).click()
  await expect(tray).toHaveCount(0)
  await paste()
  await tray.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(tray).toHaveCount(0)
  await paste()
  await page.getByRole('option', { name: /Inactive e2e-secondary/ }).click()
  await expect(tray).toHaveCount(0)
  await page.getByRole('option', { name: /main primary main/ }).click()
  await ensureTerminalVisible(page)
  await expect(tray).toHaveCount(0)
  await setCodexAuthority(page, true)
  await paste()
  await setCodexAuthority(page, false)
  await expect(tray).toHaveCount(0)
  await setCodexAuthority(page, true)
  await expect(tray).toHaveCount(0)
  await paste()
  await tray.getByRole('button', { name: 'Add to Codex', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(tray).toHaveCount(0)
  await waitForTerminalOutput(page, 'IMAGE_INPUT_COUNT=1', 10_000)
  await paste()
  await tray.getByRole('button', { name: 'Add to Codex', exact: true }).click()
  await waitForTerminalOutput(page, 'IMAGE_INPUT_COUNT=2', 10_000)
  const settlements = await electronApp.evaluate(() =>
    Reflect.get(globalThis, 'orcaImagePreviewTestSettlements')
  )
  expect(settlements).toEqual([
    ...Array.from({ length: 4 }, () => expect.objectContaining({ retain: false, release: false })),
    expect.objectContaining({ retain: true, release: false }),
    expect.objectContaining({ retain: true, release: true }),
    expect.objectContaining({ retain: true, release: false }),
    expect.objectContaining({ retain: true, release: true })
  ])

  // Saving failures must not stage or silently inject anything.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('clipboard:saveImagePreview')
    ipcMain.handle('clipboard:saveImagePreview', () => {
      throw new Error('fixture save failed')
    })
  })
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.locator('.xterm-helper-textarea').first().dispatchEvent('paste')
  await expect(page.getByText(/Image paste failed:.*fixture save failed/)).toBeVisible()
  await expect(tray).toHaveCount(0)
  await sendToTerminal(page, ptyId, '\x03')
})
