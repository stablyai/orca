import { createHash, randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/mcode-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries,
  setTerminalPtyWriteDelay
} from './helpers/terminal-pty-write-spy'

function keyboardPasteChord(): string {
  return process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
}

function largePastePayload(runId: string): string {
  return `MCODE_LARGE_PASTE_${runId}_0123456789abcdef`.repeat(4096)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function pasteReceiverScript(runId: string, expectedBytes: number, expectedHash: string): string {
  return `
const { createHash } = require('node:crypto')
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let received = ''
let done = false
const interrupt = String.fromCharCode(3)
process.stdout.write('LARGE_PASTE_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  received += chunk
  const normalized = received.replace(/\\x1b\\[200~|\\x1b\\[201~/g, '')
  const byteLength = Buffer.byteLength(normalized, 'utf8')
  if (!done && byteLength >= ${expectedBytes}) {
    done = true
    const digest = createHash('sha256').update(normalized, 'utf8').digest('hex')
    process.stdout.write('LARGE_PASTE_DONE_${runId}:' + byteLength + ':' + digest + '\\n')
    if (digest !== '${expectedHash}') {
      process.stdout.write('LARGE_PASTE_HASH_MISMATCH_${runId}\\n')
    }
  }
})
`
}

async function installRendererHeartbeat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = window as unknown as {
      __largePasteHeartbeat?: number
      __largePasteHeartbeatTimer?: number
    }
    if (global.__largePasteHeartbeatTimer !== undefined) {
      window.clearInterval(global.__largePasteHeartbeatTimer)
    }
    global.__largePasteHeartbeat = 0
    global.__largePasteHeartbeatTimer = window.setInterval(() => {
      global.__largePasteHeartbeat = (global.__largePasteHeartbeat ?? 0) + 1
    }, 0)
  })
}

async function readRendererHeartbeat(page: Page): Promise<number> {
  return page.evaluate(() => {
    const global = window as unknown as { __largePasteHeartbeat?: number }
    return global.__largePasteHeartbeat ?? 0
  })
}

async function stopRendererHeartbeat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = window as unknown as {
      __largePasteHeartbeatTimer?: number
    }
    if (global.__largePasteHeartbeatTimer !== undefined) {
      window.clearInterval(global.__largePasteHeartbeatTimer)
      delete global.__largePasteHeartbeatTimer
    }
  })
}

test.describe('large terminal paste responsiveness', () => {
  test('chunked keyboard paste keeps the renderer responsive while PTY writes are pending', async ({
    electronApp,
    mcodePage,
    testRepoPath
  }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
    await ensureTerminalVisible(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(mcodePage)
    const runId = randomUUID()
    const payload = largePastePayload(runId)
    const expectedBytes = Buffer.byteLength(payload, 'utf8')
    const expectedHash = sha256(payload)
    const doneLine = `LARGE_PASTE_DONE_${runId}:${expectedBytes}:${expectedHash}`
    const scriptPath = path.join(testRepoPath, `.mcode-large-paste-${runId}.cjs`)
    writeFileSync(scriptPath, pasteReceiverScript(runId, expectedBytes, expectedHash))
    let scriptStarted = false

    try {
      await sendToTerminal(mcodePage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      scriptStarted = true
      await waitForTerminalOutput(mcodePage, `LARGE_PASTE_READY_${runId}`, 10_000)

      await mcodePage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await clearTerminalPtyWriteLog(electronApp)
      await setTerminalPtyWriteDelay(electronApp, 35)
      await installRendererHeartbeat(mcodePage)
      await focusActiveTerminalInput(mcodePage)

      const pasteKey = mcodePage.keyboard.press(keyboardPasteChord())
      await expect
        .poll(
          async () =>
            (await readTerminalPtyWriteEntries(electronApp)).filter((entry) => entry.id === ptyId)
              .length,
          {
            timeout: 5_000,
            message: 'Large paste did not enter the chunked PTY write path'
          }
        )
        .toBeGreaterThan(1)

      const heartbeatBefore = await readRendererHeartbeat(mcodePage)
      await mcodePage.waitForTimeout(150)
      const heartbeatAfter = await readRendererHeartbeat(mcodePage)
      expect(heartbeatAfter).toBeGreaterThan(heartbeatBefore)

      await pasteKey
      await waitForTerminalOutput(mcodePage, doneLine, 20_000, 12_000)

      const writes = (await readTerminalPtyWriteEntries(electronApp)).filter(
        (entry) => entry.id === ptyId
      )
      expect(writes.length).toBeGreaterThan(1)
    } finally {
      await setTerminalPtyWriteDelay(electronApp, 0).catch(() => undefined)
      await stopRendererHeartbeat(mcodePage).catch(() => undefined)
      if (scriptStarted) {
        await sendToTerminal(mcodePage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })
})
