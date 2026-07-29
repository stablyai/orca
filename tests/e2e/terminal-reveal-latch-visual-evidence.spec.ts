/**
 * STA-2694 visual evidence generator (not a pass/fail guard — see the oracle
 * spec for that).
 *
 * Earlier screenshot oracles here were blind because they compared a revealed
 * pane against a repaired one, and both ran the same repaint code. Capturing
 * the defect directly works, because the mechanism is self-preserving: while
 * `synchronizedOutput` is latched, `RenderService.refreshRows` returns before
 * reaching the renderer, so a compositor frame just re-composites the existing
 * canvas texture. The stale pixels survive the screenshot instead of being
 * healed by it.
 *
 * So: latch the frame, write new content the pane cannot paint, and capture.
 * Buffer says one thing, screen shows another — which is the field report.
 *
 * Run with ORCA_E2E_EVIDENCE_DIR=/path to collect the PNGs.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

const EVIDENCE_DIR = process.env.ORCA_E2E_EVIDENCE_DIR ?? '/tmp/sta2694-evidence'

async function activeWebglTerminalReady(page: Page): Promise<boolean> {
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: { ...state.settings, terminalGpuAcceleration: 'on' }
    })
    for (const manager of window.__paneManagers?.values() ?? []) {
      ;(
        manager as { setTerminalGpuAcceleration?: (mode: string) => void }
      ).setTerminalGpuAcceleration?.('on')
    }
  })
  return page
    .waitForFunction(
      () => {
        for (const manager of window.__paneManagers?.values() ?? []) {
          const diagnostics =
            (
              manager as { getRenderingDiagnostics?: () => { hasWebgl: boolean }[] }
            ).getRenderingDiagnostics?.() ?? []
          if (diagnostics.some((diagnostic) => diagnostic.hasWebgl)) {
            return true
          }
        }
        return false
      },
      { timeout: 20_000 }
    )
    .then(() => true)
    .catch(() => false)
}

/** Writes to the pane's xterm buffer directly, bypassing the PTY. */
async function writeToPane(page: Page, data: string): Promise<void> {
  await page.evaluate((payload) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
        ;(pane as { terminal?: { write?: (d: string) => void } }).terminal?.write?.(payload)
      }
    }
  }, data)
  await page.waitForTimeout(600)
}

async function paneClip(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      const pane = (manager as { getPanes?: () => { container?: HTMLElement }[] }).getPanes?.()[0]
      const rect = pane?.container?.getBoundingClientRect()
      if (rect && rect.width > 10 && rect.height > 10) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
    }
    return null
  })
}

/** The visible screen text, as xterm's buffer believes it to be. */
async function readScreenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
        const terminal = (
          pane as {
            terminal?: {
              rows: number
              buffer?: {
                active?: {
                  viewportY: number
                  getLine: (
                    i: number
                  ) => { translateToString: (trim: boolean) => string } | undefined
                }
              }
            }
          }
        ).terminal
        const active = terminal?.buffer?.active
        if (!terminal || !active) {
          continue
        }
        const lines: string[] = []
        for (let y = 0; y < terminal.rows; y++) {
          lines.push(active.getLine(active.viewportY + y)?.translateToString(true) ?? '')
        }
        return lines.join('\n')
      }
    }
    return ''
  })
}

test.describe('STA-2694 visual evidence', () => {
  test('a latched frame keeps stale pixels on screen, and the fix repaints them', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    test.skip(
      !(await activeWebglTerminalReady(orcaPage)),
      'WebGL renderer unavailable in this environment'
    )
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    // 1. A settled "agent frame" on screen, painted normally.
    await writeToPane(
      orcaPage,
      `\x1b[2J\x1b[H\x1b[1;32m### AGENT FRAME 1 — BEFORE SWITCHING AWAY ###\x1b[0m\r\n\r\n${Array.from(
        { length: 8 },
        (_, i) => `  line ${i + 1}: original content ${'-'.repeat(30)}`
      ).join('\r\n')}`
    )
    const clip = await paneClip(orcaPage)
    expect(clip, 'pane rect unavailable').not.toBeNull()
    const beforeShot = await orcaPage.screenshot({ clip: clip! })
    writeFileSync(path.join(EVIDENCE_DIR, '1-before-hide.png'), beforeShot)

    // 2. Hide mid-`?2026h`: the TUI opened a frame that never closed, and the
    //    pane was occluded before it could. This is the field state.
    await orcaPage.evaluate(() => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
          const core = (pane as { terminal?: { _core?: unknown } }).terminal?._core as
            | { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
            | undefined
          const modes = core?.coreService?.decPrivateModes
          if (modes) {
            modes.synchronizedOutput = true
          }
        }
      }
    })

    // 3. The agent keeps working while hidden. The buffer advances; the canvas
    //    cannot follow, because refreshRows returns at the latch.
    await writeToPane(
      orcaPage,
      `\x1b[2J\x1b[H\x1b[1;31m### AGENT FRAME 2 — WHAT THE BUFFER NOW HOLDS ###\x1b[0m\r\n\r\n${Array.from(
        { length: 8 },
        (_, i) => `  line ${i + 1}: UPDATED content ${'#'.repeat(30)}`
      ).join('\r\n')}`
    )

    const staleShot = await orcaPage.screenshot({ clip: clip! })
    writeFileSync(path.join(EVIDENCE_DIR, '2-garbled-on-return.png'), staleShot)
    const bufferWhileStale = await readScreenText(orcaPage)

    // The buffer holds frame 2...
    expect(bufferWhileStale, 'buffer never received frame 2').toContain('AGENT FRAME 2')
    writeFileSync(path.join(EVIDENCE_DIR, 'buffer-while-garbled.txt'), bufferWhileStale, 'utf8')
    // ...while the SCREEN is byte-identical to the pre-hide capture. This is the
    // defect itself: the buffer advanced a whole frame and the canvas shows
    // none of it. It also proves the screenshot did not heal the pane, which is
    // what made the earlier pixel oracles blind.
    expect(
      Buffer.compare(beforeShot, staleShot),
      'the screen changed while the frame was latched, so no stale paint was captured'
    ).toBe(0)

    // 4. The reveal repaint Orca runs — the production fix.
    await orcaPage.evaluate(() => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        ;(manager as { scheduleRevealPresent?: () => void }).scheduleRevealPresent?.()
      }
    })
    await orcaPage.waitForTimeout(1_200)
    const repairedShot = await orcaPage.screenshot({ clip: clip! })
    writeFileSync(path.join(EVIDENCE_DIR, '3-after-fix.png'), repairedShot)

    // The latch must be gone and the pane must now be painting.
    const latchAfter = await orcaPage.evaluate(() => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
          const core = (pane as { terminal?: { _core?: unknown } }).terminal?._core as
            | { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
            | undefined
          if (core?.coreService?.decPrivateModes?.synchronizedOutput) {
            return true
          }
        }
      }
      return false
    })
    expect(latchAfter, 'the reveal repaint left the latch set').toBe(false)

    // And the fix closes the gap: the repaired capture differs from the stale
    // one, so the reveal repaint actually reached the screen.
    expect(
      Buffer.compare(staleShot, repairedShot),
      'the pre-fix and post-fix captures are byte-identical, so the fix repainted nothing'
    ).not.toBe(0)
    console.log(`[evidence] wrote PNGs to ${EVIDENCE_DIR}`)
  })
})
