/**
 * STA-1282 E2E: terminal pane eviction (Tier 1 -> Tier 2 -> Tier 0).
 *
 * Runs under an AGGRESSIVE policy (small warm budget) set via settings so
 * eviction is driven by budget overflow rather than the 5-minute dwell, which
 * real time cannot advance in an E2E run.
 *
 * Proves the load-bearing invariants:
 *  - the mounted-pane count stays bounded as tabs accumulate (the field-report
 *    metric: DOM/xterm/listener growth is what this ticket removes);
 *  - re-showing an evicted pane restores its mirror-faithful scrollback and
 *    accepts live input (gate #2);
 *  - PRIORITY (Brennan's #1 fear): a pane with a LIVE running process that keeps
 *    streaming across the whole evict->remount cycle comes back with contiguous
 *    output — no lost or duplicated bytes at the claim->snapshot->drain window
 *    (gate #2's claim-window race);
 *  - switching away then immediately back keeps the pane warm with no replay and
 *    the PTY intact (gate #9 observable);
 *  - an evicted pane's alternate-screen TUI frame rehydrates on remount (gate #2);
 *  - remounting at a different viewport size repaints and stays usable (gate #4).
 *
 * The remote-runtime (SSH/relay) evict->remount variant is a skip-marked
 * scaffold (accepted gap): it needs a live relay/runtime fixture this harness
 * lacks. Its provider-specific park path (the multiplexed host stream stays open
 * while evicted) is unit-covered by remote-runtime-pty-transport `park()`. The
 * agent-completes-while-evicted notification is likewise unit-covered (parked
 * title/status feed) and validated manually.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const WARM_BUDGET = 4

async function configureAggressiveEviction(page: Page): Promise<void> {
  await page.evaluate((warmBudget) => {
    window.__store?.getState().updateSettings({
      experimentalTerminalPaneEviction: true,
      terminalPaneEvictionWarmBudget: warmBudget,
      // Minimum dwell; eviction in this spec is driven by budget overflow.
      terminalPaneEvictionAfterMinutes: 1
    })
  }, WARM_BUDGET)
}

async function mountedTabIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window.__paneManagers?.keys() ?? [])])
}

/** Create `count` terminal tabs in the active worktree, activating each so its
 *  PTY spawns and its pane mounts, and return their ids in creation order. */
async function createTerminalTabs(page: Page, count: number): Promise<string[]> {
  const worktreeId = await waitForActiveWorktree(page)
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const tabId = await page.evaluate((wtId) => {
      const state = window.__store?.getState()
      const tab = state?.createTab(wtId, undefined, undefined, { pendingActivationSpawn: true })
      if (!tab) {
        throw new Error('createTab failed')
      }
      state?.setActiveTab(tab.id)
      return tab.id
    }, worktreeId)
    await waitForActiveTerminalManager(page)
    await discoverActivePtyId(page)
    ids.push(tabId)
  }
  return ids
}

async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.__store?.getState().setActiveTab(id), tabId)
  await waitForActiveTerminalManager(page)
}

test.describe('terminal hidden pane eviction', () => {
  test.beforeEach(async ({ orcaPage: page }) => {
    await waitForSessionReady(page)
    await ensureTerminalVisible(page)
    await configureAggressiveEviction(page)
  })

  test('mounted-pane count stays bounded while cycling many tabs', async ({ orcaPage: page }) => {
    const tabIds = await createTerminalTabs(page, WARM_BUDGET + 3)
    // Cycle through every tab so each becomes hidden-then-revisited.
    for (const tabId of tabIds) {
      await activateTab(page, tabId)
    }
    // The mounted set must stay bounded by warm budget + the visible tab + a
    // small margin for panes still awaiting their idle teardown, NOT grow with
    // the number of tabs visited.
    await expect
      .poll(async () => (await mountedTabIds(page)).length, { timeout: 15_000 })
      .toBeLessThanOrEqual(WARM_BUDGET + 2)
  })

  test('re-showing an evicted pane restores its scrollback and accepts input', async ({
    orcaPage: page
  }) => {
    const tabIds = await createTerminalTabs(page, WARM_BUDGET + 3)
    const firstTab = tabIds[0]

    // Type a unique marker into the first tab.
    await activateTab(page, firstTab)
    const marker = `evict-marker-${Date.now()}`
    const firstPtyId = await discoverActivePtyId(page)
    await execInTerminal(page, firstPtyId, `echo ${marker}`)
    await expect.poll(async () => getTerminalContent(page)).toContain(marker)

    // Push the first tab out of the warm budget by visiting the newer tabs.
    for (const tabId of tabIds.slice(1)) {
      await activateTab(page, tabId)
    }
    // The first tab is evicted: its pane manager is unmounted.
    await expect
      .poll(async () => (await mountedTabIds(page)).includes(firstTab), { timeout: 15_000 })
      .toBe(false)

    // Re-show it: the mirror snapshot replays the marker and live input echoes.
    await activateTab(page, firstTab)
    await expect.poll(async () => getTerminalContent(page)).toContain(marker)
    const restoredPtyId = await discoverActivePtyId(page)
    const echo = `after-restore-${Date.now()}`
    await execInTerminal(page, restoredPtyId, `echo ${echo}`)
    await expect.poll(async () => getTerminalContent(page)).toContain(echo)
  })

  test('a live process streaming across evict->remount restores contiguous output (no lost/dup)', async ({
    orcaPage: page
  }) => {
    // Brennan's #1 fear: how a pane with a live running process appears when you
    // return to it. A shell loop streams monotonically-increasing lines the whole
    // time the pane is evicted; on remount the mirror replay + live drain must
    // reproduce a CONTIGUOUS tail (each parsed number == previous + 1), proving
    // the claim->snapshot->drain window neither drops nor duplicates output.
    const tabIds = await createTerminalTabs(page, WARM_BUDGET + 3)
    const streamTab = tabIds[0]

    await activateTab(page, streamTab)
    const streamPtyId = await discoverActivePtyId(page)
    // ~0.05s cadence keeps output flowing across the switch + snapshot round-trip.
    // execInTerminal appends the carriage return so the loop actually runs.
    await execInTerminal(
      page,
      streamPtyId,
      'i=0; while [ $i -lt 100000 ]; do i=$((i+1)); echo "seq-$i"; sleep 0.05; done'
    )
    await expect.poll(async () => getTerminalContent(page)).toContain('seq-')

    // Evict the streaming tab (it keeps running, feeding the main mirror).
    for (const tabId of tabIds.slice(1)) {
      await activateTab(page, tabId)
    }
    await expect
      .poll(async () => (await mountedTabIds(page)).includes(streamTab), { timeout: 15_000 })
      .toBe(false)

    // Re-show it while it is still streaming.
    await activateTab(page, streamTab)

    const parseSeq = async (): Promise<number[]> => {
      const content = await getTerminalContent(page, 8000)
      return [...content.matchAll(/seq-(\d+)/g)].map((m) => Number(m[1]))
    }
    // The restored buffer must contain a run of increasing numbers.
    await expect.poll(async () => (await parseSeq()).length, { timeout: 20_000 }).toBeGreaterThan(3)

    const numbers = await parseSeq()
    // Contiguity: every consecutive pair increases by exactly 1 — no gap (lost
    // output) and no repeat (duplicated output) at the claim window boundary.
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1)
    }
    // And it is genuinely still live: a later number appears after remount.
    const highBeforeWait = numbers.at(-1) ?? 0
    await expect
      .poll(async () => {
        const seq = await parseSeq()
        return seq.at(-1) ?? 0
      })
      .toBeGreaterThan(highBeforeWait)
  })

  test('switching away then immediately back keeps the pane warm (no eviction)', async ({
    orcaPage: page
  }) => {
    const tabIds = await createTerminalTabs(page, 2)
    const [tabA, tabB] = tabIds

    await activateTab(page, tabA)
    const marker = `warm-marker-${Date.now()}`
    const ptyId = await discoverActivePtyId(page)
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await expect.poll(async () => getTerminalContent(page)).toContain(marker)

    // Switch away and immediately back — within budget and dwell, so tab A stays
    // mounted the whole time (Tier 1 warm), never evicted, no replay needed.
    await activateTab(page, tabB)
    await activateTab(page, tabA)

    expect(await mountedTabIds(page)).toContain(tabA)
    // Scrollback is still present (never lost) and the PTY is intact.
    await expect.poll(async () => getTerminalContent(page)).toContain(marker)
    expect(await discoverActivePtyId(page)).toBe(ptyId)
  })

  test('re-showing an evicted pane rehydrates its alternate-screen TUI frame (gate #2)', async ({
    orcaPage: page
  }) => {
    // The main mirror captures the alt buffer unconditionally, so an evicted
    // pane whose xterm was torn down must restore the alt-screen frame (cursor,
    // last frame) from that mirror on remount — the most-hardened replay path,
    // now run on every Tier-2 re-show.
    const tabIds = await createTerminalTabs(page, WARM_BUDGET + 3)
    const altTab = tabIds[0]

    await activateTab(page, altTab)
    const marker = `alt-${Date.now()}`
    const ptyId = await discoverActivePtyId(page)
    // Enter the alternate screen and draw a unique marker straight to the PTY.
    // \033[?1049h = enter alt buffer, \033[2J\033[H = clear + home.
    await execInTerminal(page, ptyId, `printf '\\033[?1049h\\033[2J\\033[HALT-SCREEN-${marker}'`)
    await expect.poll(async () => getTerminalContent(page)).toContain(`ALT-SCREEN-${marker}`)

    // Evict the alt-screen tab; its alt buffer lives on in the main mirror.
    for (const tabId of tabIds.slice(1)) {
      await activateTab(page, tabId)
    }
    await expect
      .poll(async () => (await mountedTabIds(page)).includes(altTab), { timeout: 15_000 })
      .toBe(false)

    // Re-show it: the mirror snapshot rehydrates the alternate-screen frame.
    await activateTab(page, altTab)
    await expect.poll(async () => getTerminalContent(page)).toContain(`ALT-SCREEN-${marker}`)
  })

  test('remounting an evicted pane at a different viewport size repaints and stays usable (gate #4)', async ({
    orcaPage: page
  }) => {
    const tabIds = await createTerminalTabs(page, WARM_BUDGET + 3)
    const sizedTab = tabIds[0]

    await activateTab(page, sizedTab)
    const marker = `sized-${Date.now()}`
    const ptyId = await discoverActivePtyId(page)
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await expect.poll(async () => getTerminalContent(page)).toContain(marker)

    // Evict the tab (push it out of the warm budget).
    for (const tabId of tabIds.slice(1)) {
      await activateTab(page, tabId)
    }
    await expect
      .poll(async () => (await mountedTabIds(page)).includes(sizedTab), { timeout: 15_000 })
      .toBe(false)

    // Resize the window while the pane is evicted so it remounts at a size that
    // differs from the frozen PTY size — the SIGWINCH-driven full-repaint path.
    await page.setViewportSize({ width: 760, height: 800 })

    // Re-show it: history replays AND the PTY reconverges to the new size (never
    // 0x0), so live input still echoes — a usable, repainted pane.
    await activateTab(page, sizedTab)
    await expect.poll(async () => getTerminalContent(page)).toContain(marker)
    const restoredPtyId = await discoverActivePtyId(page)
    const echo = `resized-echo-${Date.now()}`
    await execInTerminal(page, restoredPtyId, `echo ${echo}`)
    await expect.poll(async () => getTerminalContent(page)).toContain(echo)
  })

  // Remote-runtime (SSH/relay) evict->remount is a provider-specific park path:
  // the multiplexed host stream must stay reachable while evicted so host-side
  // scrollback + alt-screen replay on remount instead of coming back blank. This
  // harness has no live relay/runtime, so the variant is a skip-marked scaffold
  // (the accepted gap flagged in the design). The park path itself is unit-covered
  // by remote-runtime-pty-transport `park()` keeping the multiplexed stream open.
  test.skip('remote-runtime evict->remount restores non-blank host scrollback + alt-screen (accepted gap)', async () => {
    // Scaffold: pair a remote runtime, open a remote worktree terminal, drive
    // host-side scrollback + an alt-screen frame, evict past the warm budget,
    // remount, and assert the host buffer is non-blank and the alt frame restores.
  })
})
