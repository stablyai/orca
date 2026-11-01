import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient, type PairedWebClient } from './helpers/paired-electron-client'
import { callColdActivationRuntime } from './helpers/paired-terminal-cold-activation-observation'
import { createPairedTerminalParkingFixture } from './helpers/paired-terminal-parking-fixture'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const WARM_WORKTREE_COUNT = 4

type RevealSample = {
  t: number
  cols: number
  rows: number
  hidden: boolean
  ink: boolean
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    __revealGridProbe?: { samples: RevealSample[]; stop: () => RevealSample[] }
  }
}

// Samples what the pane would present on every tick and paint: its xterm grid, whether the
// screen is withheld, and whether the viewport holds replayed content (#15997).
async function startRevealGridProbe(page: Page, tabId: string): Promise<void> {
  await page.evaluate((target) => {
    const samples: RevealSample[] = []
    const started = performance.now()
    const observed = new WeakSet<object>()
    const sample = (): void => {
      const pane = window.__paneManagers?.get(target)?.getActivePane()
      const terminal = pane?.terminal
      const screen = terminal?.element?.querySelector<HTMLElement>('.xterm-screen')
      if (!terminal || !screen) {
        return
      }
      if (!observed.has(terminal)) {
        observed.add(terminal)
        terminal.onRender(sample)
      }
      const buffer = terminal.buffer.active
      let ink = false
      for (let row = 0; row < terminal.rows && !ink; row += 1) {
        ink =
          (buffer
            .getLine(buffer.viewportY + row)
            ?.translateToString(true)
            .trim() ?? '') !== ''
      }
      samples.push({
        t: Math.round(performance.now() - started),
        cols: terminal.cols,
        rows: terminal.rows,
        hidden: screen.style.opacity === '0' || screen.getBoundingClientRect().width === 0,
        ink
      })
    }
    const interval = window.setInterval(sample, 4)
    window.__revealGridProbe = {
      samples,
      stop: () => {
        window.clearInterval(interval)
        return samples
      }
    }
  }, tabId)
}

test('reveals a parked paired terminal once, at the pane grid rather than the host grid', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  const fixture = createPairedTerminalParkingFixture()
  let client: PairedWebClient | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    client = await launchPairedWebClient(host.app, host.offer, {
      terminalParkingDelayMs: 100
    })
    const page = client.page
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null), {
        timeout: 30_000
      })
      .not.toBeNull()
    const fallbackWorktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? ''
    )
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        terminalHiddenViewParking: true,
        terminalHiddenWorktreeRetentionBudget: false
      })
    })
    const marker = `REVEAL_GRID_${Date.now()}`
    const createTerminalWorktree = async (
      index: number
    ): Promise<{ worktreeId: string; terminal: string; tabId: string }> => {
      const created = await callColdActivationRuntime<{
        startupTerminal?: { handle?: string; tabId?: string }
        worktree: { id: string }
      }>(page, 'worktree.create', {
        repo: added.result.repo.id,
        name: `reveal-grid-${Date.now()}-${index}`,
        setupDecision: 'skip',
        activate: false,
        noParent: true,
        startupCommand: fixture.command(`${marker}_${index}`)
      })
      const handle = created.startupTerminal?.handle
      const hostTabId = created.startupTerminal?.tabId
      if (!handle || !hostTabId) {
        throw new Error(`Reveal-grid startup terminal ${index} was not created`)
      }
      return {
        worktreeId: created.worktree.id,
        terminal: handle,
        tabId: toWebTerminalSurfaceTabId(hostTabId)
      }
    }
    // Why the extra worktrees: the most recent TERMINAL_WORKTREE_HOT_RETAIN_LIMIT worktrees stay warm.
    const worktrees: Awaited<ReturnType<typeof createTerminalWorktree>>[] = []
    for (let index = 0; index <= WARM_WORKTREE_COUNT; index += 1) {
      worktrees.push(await createTerminalWorktree(index))
    }
    const target = worktrees[0]
    const { tabId, terminal: terminalHandle } = target
    const openTab = async (entry: { worktreeId: string; tabId: string }): Promise<void> => {
      await page.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(id)
      }, entry.worktreeId)
      const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${entry.tabId}"]`)
      await expect(tab).toBeVisible({ timeout: 30_000 })
      await tab.click()
      await waitForActivePanePtyId(page, 30_000)
    }
    await openTab(target)
    await callColdActivationRuntime(page, 'terminal.send', {
      terminal: terminalHandle,
      text: 'FILL',
      enter: true,
      client: { id: 'reveal-grid-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`FILLED:${marker}_0`)
    const hostGrid = await page.evaluate((id) => {
      const terminal = window.__paneManagers?.get(id)?.getActivePane()?.terminal
      return terminal ? { cols: terminal.cols, rows: terminal.rows } : null
    }, tabId)
    expect(hostGrid).not.toBeNull()

    for (const warm of worktrees.slice(1)) {
      await openTab(warm)
    }
    await page.evaluate(
      (id) => window.__store?.getState().setActiveWorktree(id),
      fallbackWorktreeId
    )
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              !window.__paneManagers?.has(id) &&
              (window.__terminalParkingDebug?.parkedTabIds() ?? []).includes(id),
            tabId
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    // Why: the parked PTY keeps the host grid, so the reveal's snapshot is at a foreign grid.
    await host.app.evaluate(({ BrowserWindow }, url) => {
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL() === url)
        ?.setContentSize(1080, 860)
    }, page.url())
    await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBe(1080)

    await startRevealGridProbe(page, tabId)
    await openTab(target)
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`FILLED:${marker}_0`)
    // Let the reveal's fit, claims and any follow-up snapshot settle.
    await page.waitForTimeout(1_500)
    const samples = await page.evaluate(() => window.__revealGridProbe?.stop() ?? [])
    const samplesPath = test.info().outputPath('reveal-grid-samples.json')
    writeFileSync(samplesPath, JSON.stringify({ hostGrid, samples }, null, 2))
    await test.info().attach('reveal-grid-samples', {
      path: samplesPath,
      contentType: 'application/json'
    })
    const final = samples.at(-1)
    if (!final || !hostGrid) {
      throw new Error('Reveal-grid probe captured no samples')
    }
    expect(final.hidden).toBe(false)
    // Non-vacuous: the pane really fits to a different grid than the snapshot was captured at.
    expect({ cols: final.cols, rows: final.rows }).not.toEqual(hostGrid)
    const presentedForeignGrid = samples.filter(
      (sample) =>
        !sample.hidden && sample.ink && (sample.cols !== final.cols || sample.rows !== final.rows)
    )
    expect(presentedForeignGrid).toEqual([])
    // A follow-up replay's clear must not flash the painted pane blank either.
    const firstPainted = samples.findIndex((sample) => !sample.hidden && sample.ink)
    const presentedBlankAfterPaint = samples
      .slice(Math.max(firstPainted, 0))
      .filter((sample) => !sample.hidden && !sample.ink)
    expect(presentedBlankAfterPaint).toEqual([])
  } finally {
    await client?.dispose()
    await host.dispose()
    fixture.dispose()
  }
})
