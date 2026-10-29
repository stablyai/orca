// P3/#23429 (fixed by #26022): retain desktop/CLI daemon @@ PTYs beside a serve-minted PTY across serve restart.
// Compare host inventory/layout and the reconnected desktop against the baseline.
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import {
  expectLayoutCompatBaseline,
  IdLabels,
  publishedLayoutBaseline,
  readPublishedLayout,
  readSessionTabs,
  readSettled,
  readTerminals,
  sessionTabsBaseline
} from './helpers/layout-compat-baseline'
import type { RuntimeTerminalCreate } from '../../src/shared/runtime-terminal-contracts'

const PANE = '.pane[data-leaf-id]:visible'
const TAB = '[data-testid="sortable-tab"]'
// tab1 is the desktop's, tab2 the CLI's, tab3 serve's; the published orders seen after a restart.
const RESTART_ORDERS = [
  ['tab1', 'tab2', 'tab3'],
  ['tab1', 'tab3', 'tab2']
]

/** An untitled row is named by its list position ("Terminal 2"); kept, but position-free. */
function positionalTitle(title: string, index: number): string {
  if (!/^Terminal \d+$/.test(title)) {
    return title
  }
  expect(title).toBe(`Terminal ${index + 1}`)
  return 'Terminal <position>'
}

test('serve-restart-keeps-@@-terminals: desktop, CLI and serve terminals survive a serve restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'serve restart')
    try {
      const page = desktop.page
      let worktreeId = ''
      await expect
        .poll(
          async () =>
            (worktreeId = await page.evaluate(
              (repo) =>
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .find((worktree) => worktree.path === repo)?.id ?? '',
              testRepoPath
            )),
          { timeout: 60_000 }
        )
        .not.toBe('')
      const worktree = `id:${worktreeId}`
      // Opening an empty server workspace makes the desktop create its first terminal there.
      await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
      await expect(page.locator(PANE)).toHaveCount(1, { timeout: 60_000 })
      const cli = await host.client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
        worktree,
        title: 'cli-created'
      })
      // The CLI's tab is placed after its reply; wait for it so the tab order is fixed.
      await expect
        .poll(async () => (await readSessionTabs(host.client, worktree)).tabs.length)
        .toBe(2)
      const served = await host.client.call<{ tab: { parentTabId: string } }>(
        'session.tabs.createTerminal',
        { worktree, activate: false, select: false, navigation: 'caller' }
      )

      const labels = new IdLabels()
      const read = async () => ({
        server: sessionTabsBaseline(await readSessionTabs(host.client, worktree), labels),
        terminals: await readTerminals(host.client, worktree, labels),
        published: publishedLayoutBaseline(
          await readPublishedLayout(host.offer.pairingUrl, worktreeId),
          labels
        ),
        desktopTabs: await page.locator(TAB).count(),
        desktopPanes: await page.locator(PANE).count()
      })
      await expect
        .poll(async () => (await readSessionTabs(host.client, worktree)).tabs.length)
        .toBe(3)
      const before = await readSettled(read)

      await host.restartServeProcess()
      await expect(page.locator(TAB)).not.toHaveCount(0, { timeout: 60_000 })
      // The restarted server lists its terminals a moment after it answers; this scenario is that they come back.
      await expect
        .poll(async () => (await readTerminals(host.client, worktree, labels)).length, {
          timeout: 60_000
        })
        .toBe(before.terminals.length)
      const settled = await readSettled(read)
      // Main changes order on restart: accept identical tabs in any list order and either observed published order.
      // Canonicalize only those observed variations; other changes must fail.
      expect(settled.server.groups).toHaveLength(1)
      const canonicalSelection = before.server.groups[0]!.active
      expect(settled.server.groups[0]!.tabs.toSorted()).toEqual(RESTART_ORDERS[0])
      // Selection follows the first listed tab; group selection may also retain the desktop’s tab.
      const firstListed = settled.server.groups[0]!.tabs[0]
      expect(settled.server.activeTab).toBe(firstListed)
      expect([canonicalSelection, firstListed]).toContain(settled.server.groups[0]!.active)
      const published = settled.published?.groups
      expect(published).toHaveLength(1)
      expect(
        RESTART_ORDERS.some((order) => JSON.stringify(order) === JSON.stringify(published?.[0])),
        `published order after the restart: ${JSON.stringify(published)}`
      ).toBe(true)
      expect(settled.published?.tabs.map((tab) => tab.tab)).toEqual(published?.[0])
      const canonical = RESTART_ORDERS[0]!
      const byCanonical = (a: { tab: string | null }, b: { tab: string | null }) =>
        canonical.indexOf(a.tab ?? '') - canonical.indexOf(b.tab ?? '')
      const after = {
        ...settled,
        server: {
          ...settled.server,
          activeTab: '<first listed>',
          groups: [{ active: '<desktop tab or first listed>', tabs: canonical }],
          rows: settled.server.rows
            .map((row, index) => ({ ...row, title: positionalTitle(row.title, index) }))
            .toSorted(byCanonical)
        },
        published: settled.published && {
          ...settled.published,
          groups: [canonical],
          tabs: settled.published.tabs.toSorted(byCanonical)
        }
      }

      await expectLayoutCompatBaseline(testInfo, 'serve-restart-keeps-@@-terminals', {
        created: {
          cli: labels.pty(cli.result.terminal.ptyId),
          serve: labels.label('tab', served.result.tab.parentTabId)
        },
        before,
        after
      })
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
