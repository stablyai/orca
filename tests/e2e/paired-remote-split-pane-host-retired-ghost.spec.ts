/**
 * Reproduction for #17770: closing one pane of a split terminal in a paired
 * remote-server workspace must not leave the other pane mounted as a blank,
 * dead ghost.
 *
 * Topology: a headless paired Orca runtime host + a paired Orca desktop client.
 * The host owns the pane layout; the client mirrors it. The host splits a
 * terminal (two leaves, two remote PTYs, each a login shell), then the user
 * quits the second shell with `exit`. The host retires that leaf and
 * republishes a one-leaf layout.
 *
 * Before the fix, the host-authoritative reconciler planned insertions only, so
 * the client kept the retired leaf's pane mounted forever — a blank ghost with
 * no exit overlay and no restart control. The refutation-proof shape (verified
 * here) is that the client's store layout shrinks to one leaf while its DOM
 * keeps two panes. After the fix the client removes the retired pane and store
 * + DOM agree at exactly the surviving leaf.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/paired-remote-split-pane-host-retired-ghost.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import type { Page } from '@stablyai/playwright-test'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { findPairedWorktreeId } from './helpers/paired-browser-placement-fixture'

async function mountedPaneCount(page: Page, webTabId: string): Promise<number> {
  return page.evaluate(
    (tabId) => window.__paneManagers?.get(tabId)?.getPanes().length ?? -1,
    webTabId
  )
}

async function mountedLeafPtyIds(
  page: Page,
  webTabId: string
): Promise<{ leafId: string; ptyId: string | null }[]> {
  return page.evaluate(
    (tabId) =>
      (window.__paneManagers?.get(tabId)?.getPanes() ?? []).map((pane) => ({
        leafId: pane.leafId,
        ptyId: pane.container.dataset.ptyId ?? null
      })),
    webTabId
  )
}

/** Leaves the host-authoritative layout the client currently holds for this tab. */
async function hostLayoutLeafIds(page: Page, webTabId: string): Promise<string[]> {
  return page.evaluate((tabId) => {
    const layout = window.__store?.getState().terminalLayoutsByTabId[tabId]
    return layout ? Object.keys(layout.ptyIdsByLeafId ?? {}) : []
  }, webTabId)
}

test('removes the pane a paired remote host retired instead of leaving a dead ghost', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const created = await host.client.call<{ terminal: { handle: string } }>('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Ghost Repro'
    })
    const firstHandle = created.result.terminal.handle

    client = await launchPairedElectronClient(host.offer, testInfo, '#17770 host-retired ghost')
    const worktreeId = await findPairedWorktreeId(client.page, testRepoPath)
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )

    // Host splits the terminal: a second leaf with its own remote login shell.
    const split = await host.client.call<{ split: { handle: string; tabId: string } }>(
      'terminal.split',
      { terminal: firstHandle, direction: 'horizontal' }
    )
    const secondHandle = split.result.split.handle
    const webTabId = toWebTerminalSurfaceTabId(split.result.split.tabId)

    // The client mirrors the split as two mounted panes, each PTY-bound.
    await expect
      .poll(() => mountedPaneCount(client!.page, webTabId), {
        timeout: 90_000,
        message: 'paired client never materialized both split panes'
      })
      .toBe(2)
    await expect
      .poll(async () => (await mountedLeafPtyIds(client!.page, webTabId)).every((p) => p.ptyId), {
        timeout: 30_000,
        message: 'split panes never settled with PTY bindings'
      })
      .toBe(true)
    const beforeExit = await mountedLeafPtyIds(client.page, webTabId)

    // The user quits the second shell — the host retires that leaf and
    // republishes a one-leaf layout.
    await host.client.call('terminal.send', { terminal: secondHandle, text: 'exit', enter: true })

    // The host-authoritative layout the client holds shrinks to one leaf
    // (confirms the retirement). This is the refutation-proof signal: before the
    // fix the store layout shrinks here while the DOM keeps a ghost; after the
    // fix the DOM follows and both agree at one leaf.
    await expect
      .poll(() => hostLayoutLeafIds(client!.page, webTabId).then((ids) => ids.length), {
        timeout: 60_000,
        message: 'host never retired the exited split leaf from its published layout'
      })
      .toBe(1)

    // The client must drop the retired pane and keep exactly the surviving one.
    await expect
      .poll(() => mountedPaneCount(client!.page, webTabId), {
        timeout: 60_000,
        message: 'paired client kept the retired pane mounted as a dead ghost'
      })
      .toBe(1)

    const afterExit = await mountedLeafPtyIds(client.page, webTabId)
    const exitedLeafId = beforeExit.find(
      (p) => !afterExit.some((a) => a.leafId === p.leafId)
    )?.leafId
    expect(afterExit).toHaveLength(1)
    expect(afterExit[0]?.leafId).toBeTruthy()
    expect(afterExit[0]?.ptyId).toBeTruthy()
    expect(exitedLeafId).toBeTruthy()
    // The pane that survives is the one the host still names.
    await expect(hostLayoutLeafIds(client.page, webTabId)).resolves.toEqual([afterExit[0]?.leafId])
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
