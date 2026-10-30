// #17770: a headless host retires an exited split leaf; client store and DOM must retain exactly the surviving pane.
// Insertion-only reconciliation shrank store layout but left a dead DOM ghost; retiring the active leaf must also avoid writing it back during PTY exit.
import type { Page, TestInfo } from '@stablyai/playwright-test'
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

async function expectHostRetiredPaneRemoved(
  exitedPane: 'split' | 'original',
  testRepoPath: string,
  testInfo: TestInfo
): Promise<void> {
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

    const split = await host.client.call<{ split: { handle: string; tabId: string } }>(
      'terminal.split',
      { terminal: firstHandle, direction: 'horizontal' }
    )
    const secondHandle = split.result.split.handle
    const webTabId = toWebTerminalSurfaceTabId(split.result.split.tabId)

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

    await host.client.call('terminal.send', {
      terminal: exitedPane === 'split' ? secondHandle : firstHandle,
      text: 'exit',
      enter: true
    })

    // Require both one-leaf host layout and one DOM pane; store-only assertions passed with the old ghost.
    await expect
      .poll(() => hostLayoutLeafIds(client!.page, webTabId).then((ids) => ids.length), {
        timeout: 60_000,
        message: 'host never retired the exited split leaf from its published layout'
      })
      .toBe(1)

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
    await expect(hostLayoutLeafIds(client.page, webTabId)).resolves.toEqual([afterExit[0]?.leafId])
  } finally {
    await client?.dispose()
    await host.dispose()
  }
}

test('removes the pane a paired remote host retired instead of leaving a dead ghost', async ({
  testRepoPath
}, testInfo) => expectHostRetiredPaneRemoved('split', testRepoPath, testInfo))

// Why: the original pane is the host's active leaf, so its retirement also moves focus.
test('removes the original pane a paired remote host retired after it exits', async ({
  testRepoPath
}, testInfo) => expectHostRetiredPaneRemoved('original', testRepoPath, testInfo))
