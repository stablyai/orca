import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type Grid = { cols: number; rows: number }
type GridSnapshot = { applied: Grid | null; xterm: Grid | null }

async function readGridSnapshot(page: Page, ptyId: string): Promise<GridSnapshot> {
  return page.evaluate(async (id) => {
    let xterm: Grid | null = null
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes?.() ?? []) {
        if (pane.container?.dataset?.ptyId === id) {
          xterm = { cols: pane.terminal.cols, rows: pane.terminal.rows }
        }
      }
    }
    return { applied: (await window.api.pty.getSize(id)) ?? null, xterm }
  }, ptyId)
}

function chooseStaleGrid(current: Grid): Grid {
  return {
    cols: Math.max(40, current.cols - 19),
    rows: Math.max(12, current.rows - 7)
  }
}

test.describe('terminal window-wake stale grid repro', () => {
  test('window focus heals a local PTY whose applied grid drifted from xterm', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const baseline = await readGridSnapshot(orcaPage, ptyId)
    expect(baseline.xterm).not.toBeNull()
    expect(baseline.applied).toEqual(baseline.xterm)
    const staleGrid = chooseStaleGrid(baseline.xterm!)

    // Why: model the field state directly—xterm is fitted, but the idle PTY
    // still has an older grid and produces no output that could self-heal it.
    await orcaPage.evaluate(({ id, grid }) => window.api.pty.resize(id, grid.cols, grid.rows), {
      id: ptyId,
      grid: staleGrid
    })
    await expect
      .poll(async () => (await readGridSnapshot(orcaPage, ptyId)).applied, { timeout: 10_000 })
      .toEqual(staleGrid)
    expect((await readGridSnapshot(orcaPage, ptyId)).xterm).toEqual(baseline.xterm)

    await orcaPage.evaluate(() => window.dispatchEvent(new Event('focus')))

    await expect
      .poll(
        async () => {
          const snapshot = await readGridSnapshot(orcaPage, ptyId)
          return snapshot.applied && snapshot.xterm ? snapshot : null
        },
        { timeout: 10_000, message: 'Window focus should converge the local PTY to xterm' }
      )
      .toEqual({ applied: baseline.xterm, xterm: baseline.xterm })
  })
})
