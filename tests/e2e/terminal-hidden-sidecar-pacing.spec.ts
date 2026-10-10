/**
 * A hidden pane whose PTY a raw-byte sidecar still watches (background-launched
 * and automation agents) must not be paced by the hidden renderer. Chromium
 * clamps a hidden page's timers (to one wake-up a minute after ~5 minutes), and
 * the view's background parse runs on timers; when its credit gated the PTY, a
 * flooding agent slowed to tens of KB/s and blocked on its own writes.
 *
 * The test pins the hidden page the way terminal-stuck-occlusion-recovery does,
 * registers delivery interest, clamps timers to 60 s, floods 2 MB, and expects
 * the producer to finish at full speed and the reveal to show its output.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  waitForActiveTerminalManager,
  waitForActivePanePtyId,
  execInTerminal,
  getTerminalContent
} from './helpers/terminal'

const FLOOD_BYTES = 2 * 1024 * 1024
// Before the fix this flood took ~45 s under the 60 s clamp; at full speed it takes ~1 s.
const PRODUCER_DEADLINE_MS = 20_000

const PRODUCER = `
const fs = require('fs')
const [total, out, go, ready] = [Number(process.argv[2]), process.argv[3], process.argv[4], process.argv[5]]
const chunk = ('x'.repeat(99) + '\\n').repeat(655)
fs.writeFileSync(ready, '1')
const wait = setInterval(() => {
  if (!fs.existsSync(go)) return
  clearInterval(wait)
  let written = 0
  const start = Date.now()
  const pump = () => {
    while (written < total) {
      written += chunk.length
      if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return }
    }
    fs.writeFileSync(out, String(Date.now() - start))
    process.stdout.write('\\nsidecar-flood-' + 'done\\n')
  }
  pump()
}, 20)
`

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function hiddenDeliveryGatedPtyCount(page: Page): Promise<number> {
  return page.evaluate(
    async () =>
      (await window.api.pty.getRendererDeliveryDebugSnapshot()).hiddenDeliveryGatedPtyCount
  )
}

test.describe('terminal hidden sidecar pacing', () => {
  test.afterEach(async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      const originalSetTimeout = Reflect.get(window, '__sidecarPacingSetTimeout')
      if (originalSetTimeout) {
        Reflect.set(window, 'setTimeout', originalSetTimeout)
        Reflect.set(window, 'requestAnimationFrame', Reflect.get(window, '__sidecarPacingRaf'))
      }
      // Drop the instance shadow so the prototype getter (real state) rules again.
      Reflect.deleteProperty(document, 'visibilityState')
      document.dispatchEvent(new Event('visibilitychange'))
    })
  })

  test('a hidden pane with a raw-byte sidecar does not pace its PTY to throttled timers', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)

    const dir = mkdtempSync(path.join(tmpdir(), 'orca-sidecar-pacing-'))
    const script = path.join(dir, 'producer.cjs')
    const out = path.join(dir, 'wall-ms')
    const go = path.join(dir, 'go')
    const ready = path.join(dir, 'ready')
    writeFileSync(script, PRODUCER)
    // Typed while timers run normally; the producer waits for the go file.
    await execInTerminal(orcaPage, ptyId, `node ${script} ${FLOOD_BYTES} ${out} ${go} ${ready}`)
    expect(await waitForFile(ready, 30_000)).toBe(true)

    await orcaPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'hidden',
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect.poll(() => hiddenDeliveryGatedPtyCount(orcaPage), { timeout: 15_000 }).toBe(1)
    await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, true), ptyId)
    await orcaPage.evaluate(() => {
      const originalSetTimeout = window.setTimeout.bind(window)
      Reflect.set(window, '__sidecarPacingSetTimeout', originalSetTimeout)
      Reflect.set(window, '__sidecarPacingRaf', window.requestAnimationFrame.bind(window))
      // Chromium's intensive hidden-page throttling: one timer wake-up a minute, no rAF.
      Reflect.set(window, 'setTimeout', (handler: TimerHandler, ms?: number, ...args: unknown[]) =>
        originalSetTimeout(handler, Math.max(60_000, ms ?? 0), ...args)
      )
      Reflect.set(window, 'requestAnimationFrame', () => 0)
    })

    writeFileSync(go, '1')
    expect(await waitForFile(out, PRODUCER_DEADLINE_MS)).toBe(true)
    expect(Number(readFileSync(out, 'utf8'))).toBeLessThan(PRODUCER_DEADLINE_MS)

    await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, false), ptyId)
    await orcaPage.evaluate(() => {
      Reflect.set(window, 'setTimeout', Reflect.get(window, '__sidecarPacingSetTimeout'))
      Reflect.set(window, 'requestAnimationFrame', Reflect.get(window, '__sidecarPacingRaf'))
      Reflect.deleteProperty(window, '__sidecarPacingSetTimeout')
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // The view skipped the flood, so the reveal repaints it from the main-owned model.
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 90_000 })
      .toContain('sidecar-flood-done')
  })
})
