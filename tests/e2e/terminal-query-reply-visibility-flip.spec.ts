/**
 * A terminal query gets exactly one reply even when the pane's visibility flips while the
 * chunk carrying it is still queued in main. Main decides who answers when it ingests the
 * chunk: the pane's view while visible, main's model while the view is gated.
 *
 * Each test holds the renderer's delivery credit so main's in-flight window fills and the
 * query stays queued, flips the pane, then releases the credit and counts the replies the
 * program reads. Before the fix a hide flip dropped the queued query (no reply) and a
 * reveal flip handed the view a query main had already answered (two replies).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  waitForActiveTerminalManager,
  waitForActivePanePtyId,
  execInTerminal
} from './helpers/terminal'

const PROGRAM = `
const fs = require('fs')
const [out, ready, go1, stop1, sent1, go2, sent2] = process.argv.slice(2)
let replies = ''
// Written then renamed, so the test never reads a half-written file.
const record = () => {
  fs.writeFileSync(out + '.tmp', JSON.stringify({
    cpr: (replies.match(/\\x1b\\[\\d+;\\d+R/g) || []).length,
    da1: (replies.match(/\\x1b\\[\\?[\\d;]*c/g) || []).length
  }))
  fs.renameSync(out + '.tmp', out)
}
process.stdin.setRawMode(true)
process.stdin.on('data', (data) => { replies += data.toString('latin1'); record() })
record()
const whenExists = (file) => new Promise((resolve) => {
  const wait = setInterval(() => { if (fs.existsSync(file)) { clearInterval(wait); resolve() } }, 20)
})
// Paced filler while stop1 is absent: slow enough that the queue behind the held window
// stays far below the size at which main pauses the PTY, fast enough that the held window
// fills well inside main's 10 s ack-silence heal. sent1 marks each idle period.
let idle = false
const fill = () => {
  if (fs.existsSync(stop1)) {
    if (!idle) fs.writeFileSync(sent1, '1')
    idle = true
    setTimeout(fill, 20)
    return
  }
  idle = false
  process.stdout.write(('x'.repeat(99) + '\\n').repeat(160), () => setTimeout(fill, 20))
}
fs.writeFileSync(ready, '1')
whenExists(go1).then(fill)
whenExists(go2).then(() => process.stdout.write('query:\\x1b[6n\\x1b[c\\n', () => {
  fs.writeFileSync(sent2, '1')
  setTimeout(() => process.exit(0), 120000)
}))
`

type Replies = { cpr: number; da1: number }

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${file}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function readReplies(file: string): Replies {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'cpr' in parsed &&
    typeof parsed.cpr === 'number' &&
    'da1' in parsed &&
    typeof parsed.da1 === 'number'
  ) {
    return { cpr: parsed.cpr, da1: parsed.da1 }
  }
  throw new Error(`unreadable reply counts in ${file}`)
}

async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    if (nextHidden) {
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'hidden',
        configurable: true
      })
    } else {
      // Drop the instance shadow so the prototype getter (real state) rules again.
      Reflect.deleteProperty(document, 'visibilityState')
    }
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot()))
          .hiddenDeliveryGatedPtyCount,
      { timeout: 15_000 }
    )
    .toBe(hidden ? 1 : 0)
}

async function setAckGate(page: Page, ptyId: string | null): Promise<void> {
  await page.evaluate((id) => {
    const gate: unknown = Reflect.get(window, '__terminalPtyAckGate')
    const method = id ? 'hold' : 'release'
    const call: unknown = typeof gate === 'object' && gate ? Reflect.get(gate, method) : null
    if (typeof gate !== 'object' || !gate || typeof call !== 'function') {
      throw new Error('terminal PTY ACK gate is unavailable')
    }
    Reflect.apply(call, gate, id ? [[id]] : [])
  }, ptyId)
}

// Queued behind the held window, not just batched: the window is full and bytes still wait.
async function isOutputQueuedBehindWindow(page: Page): Promise<boolean> {
  const debug = await page.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot())
  return debug.pendingChars > 0 && debug.maxRendererInFlightCharsByPty >= 512 * 1024
}

async function startProgram(page: Page): Promise<{
  ptyId: string
  out: string
  go: (phase: 1 | 2) => Promise<void>
}> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-query-flip-'))
  const file = (name: string): string => path.join(dir, name)
  writeFileSync(file('program.cjs'), PROGRAM)
  const args = ['out', 'ready', 'go1', 'stop1', 'sent1', 'go2', 'sent2'].map(file).join(' ')
  await execInTerminal(page, ptyId, `node ${file('program.cjs')} ${args}`)
  await waitForFile(file('ready'), 30_000)
  return {
    ptyId,
    out: file('out'),
    go: async (phase) => {
      writeFileSync(file(`go${phase}`), '1')
      // An active pane's window is larger, so batching can look queued: stop, then confirm.
      for (let attempt = 0; phase === 1 && attempt < 10; attempt++) {
        await expect
          .poll(() => isOutputQueuedBehindWindow(page), { intervals: [50], timeout: 30_000 })
          .toBe(true)
        writeFileSync(file('stop1'), '1')
        await waitForFile(file('sent1'), 30_000)
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (await isOutputQueuedBehindWindow(page)) {
          return
        }
        rmSync(file('sent1'))
        rmSync(file('stop1'))
      }
      if (phase === 2) {
        await waitForFile(file('sent2'), 30_000)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      expect(await isOutputQueuedBehindWindow(page)).toBe(true)
    }
  }
}

test.describe('terminal query replies across a visibility flip', () => {
  test.afterEach(async ({ orcaPage }) => {
    await setAckGate(orcaPage, null).catch(() => undefined)
    await orcaPage.evaluate(() => {
      Reflect.deleteProperty(document, 'visibilityState')
      document.dispatchEvent(new Event('visibilitychange'))
    })
  })

  test('a query queued while visible is answered once after the pane hides', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    const program = await startProgram(orcaPage)
    await setAckGate(orcaPage, program.ptyId)
    await program.go(1)
    await program.go(2)

    await setPageHidden(orcaPage, true)
    await setAckGate(orcaPage, null)

    await expect
      .poll(() => readReplies(program.out), { timeout: 15_000 })
      .toEqual({ cpr: 1, da1: 1 })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(readReplies(program.out)).toEqual({ cpr: 1, da1: 1 })
  })

  test('a query main answered while hidden is not answered again after a reveal', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    const program = await startProgram(orcaPage)
    await setAckGate(orcaPage, program.ptyId)
    await program.go(1)

    // A sidecar keeps the hidden bytes queued instead of dropped.
    await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, true), program.ptyId)
    await setPageHidden(orcaPage, true)
    await program.go(2)
    await expect
      .poll(() => readReplies(program.out), { timeout: 15_000 })
      .toEqual({ cpr: 1, da1: 1 })

    await setPageHidden(orcaPage, false)
    await setAckGate(orcaPage, null)
    await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, false), program.ptyId)

    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(readReplies(program.out)).toEqual({ cpr: 1, da1: 1 })
  })
})
