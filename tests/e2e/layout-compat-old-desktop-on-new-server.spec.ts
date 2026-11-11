// P3 baseline: pinned released desktop/CLI split and close server panes, then reconnect to current serve after restart.
// Requires ORCA_CROSS_VERSION_PACKAGED_EXECUTABLE (packaged-browser-e2e.yml layout-compat).
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPackagedPairedClient,
  packagedExecutable,
  packagedExecutableMissing,
  PACKAGED_EXECUTABLE_ENV,
  runPackagedOrcaCli
} from './helpers/packaged-old-orca'
import {
  expectLayoutCompatBaseline,
  expectReconnectedPaneEcho,
  IdLabels,
  publishedLayoutBaseline,
  readPublishedLayout,
  readSessionTabs,
  readSettled,
  readTerminals,
  sessionTabsBaseline
} from './helpers/layout-compat-baseline'
import type { RuntimeTerminalCreate } from '../../src/shared/runtime-terminal-contracts'

// Panes of the shown tab; other tabs keep theirs mounted but hidden.
const PANE = '.pane[data-leaf-id]:visible'
const TAB = '[data-testid="sortable-tab"]'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
// The released build's default split-right binding (definitions-core-4.ts at the pinned tag).
const SPLIT_RIGHT = process.platform === 'darwin' ? 'Meta+d' : 'Control+Shift+D'

function drawnLeaves(page: Page): Promise<string[]> {
  return page.locator(PANE).evaluateAll((panes) => panes.map((pane) => pane.dataset.leafId ?? ''))
}

async function focusPane(page: Page, leafId: string): Promise<void> {
  await page.locator(`${PANE}[data-leaf-id="${leafId}"] .xterm`).click()
}

test.describe('layout compat: released desktop and CLI on the current server', () => {
  test.skip(packagedExecutableMissing, `${PACKAGED_EXECUTABLE_ENV} must point at a released Orca`)

  test('old-desktop-on-new-server: split, close pane, server restart', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
    try {
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      const created = await host.client.call<{ terminal: RuntimeTerminalCreate }>(
        'terminal.create',
        {
          worktree: `path:${testRepoPath}`,
          title: 'host-made'
        }
      )
      const worktreeId = created.result.terminal.worktreeId
      const worktree = `id:${worktreeId}`
      const client = await launchPackagedPairedClient({
        executablePath: packagedExecutable!,
        offer: host.offer,
        testInfo,
        name: 'released desktop'
      })
      try {
        const labels = new IdLabels()
        const steps: unknown[] = []
        const record = async (step: string): Promise<void> => {
          const observed = await readSettled(async () => ({
            server: sessionTabsBaseline(await readSessionTabs(host.client, worktree), labels),
            serverTerminals: await readTerminals(host.client, worktree, labels),
            published: publishedLayoutBaseline(
              await readPublishedLayout(host.offer.pairingUrl, worktreeId),
              labels
            ),
            // A count: a tab's label follows its focused pane's shell title, which differs per machine.
            oldDesktopTabs: await client.page.locator(TAB).count(),
            oldDesktopPanes: (await drawnLeaves(client.page)).map((id) => labels.label('leaf', id))
          }))
          steps.push({ step, ...observed })
        }

        await client.page
          .locator(`[data-worktree-id="${worktreeId}"] [data-worktree-card-surface]`)
          .click()
        await expect(client.page.locator(PANE)).toHaveCount(1, { timeout: 60_000 })
        // The released desktop opens a tab of its own in the server workspace; it draws that tab.
        await record('old desktop opens the server workspace')

        const [firstLeaf] = await drawnLeaves(client.page)
        await focusPane(client.page, firstLeaf!)
        await client.page.keyboard.press(SPLIT_RIGHT)
        await expect(client.page.locator(PANE)).toHaveCount(2, { timeout: 30_000 })
        await record('old desktop splits right')

        const secondLeaf = (await drawnLeaves(client.page)).find((leaf) => leaf !== firstLeaf)!
        await focusPane(client.page, secondLeaf)
        await client.page.keyboard.press(`${MOD}+w`)
        const confirm = client.page.getByRole('button', { name: 'Stop and Close' })
        await expect
          .poll(async () => {
            if (await confirm.isVisible().catch(() => false)) {
              await confirm.click()
            }
            return client.page.locator(PANE).count()
          })
          .toBe(1)
        await record('old desktop closes the new pane')

        await host.restartServeProcess()
        await expectReconnectedPaneEcho({
          page: client.page,
          environmentId: client.environmentId,
          leafId: firstLeaf!,
          host: host.client,
          worktree,
          // The packaged client draws with the DOM renderer (packaged-old-orca.ts), so rows are text.
          readDrawn: () =>
            client.page.locator(`${PANE}[data-leaf-id="${firstLeaf}"] .xterm-rows`).textContent()
        })
        await expect(client.page.locator(PANE)).toHaveCount(1)
        await record('after server restart')

        await expectLayoutCompatBaseline(testInfo, 'old-desktop-on-new-server', {
          oldDesktopVersion: client.version,
          steps
        })
      } finally {
        await client.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  test('old-cli-terminal-create: the released CLI creates a terminal on the current server', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(180_000)
    const host = await launchHeadlessPairedRuntimeHost()
    try {
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      const run = await runPackagedOrcaCli(packagedExecutable!, host.userDataDir, [
        'terminal',
        'create',
        '--worktree',
        `path:${testRepoPath}`,
        '--title',
        'old-cli',
        '--json'
      ])
      const result = run.json?.result
      const terminal: object =
        result &&
        typeof result === 'object' &&
        'terminal' in result &&
        result.terminal &&
        typeof result.terminal === 'object'
          ? result.terminal
          : {}
      const labels = new IdLabels()
      const listed = await readSessionTabs(host.client, `path:${testRepoPath}`)
      await expectLayoutCompatBaseline(testInfo, 'old-cli-terminal-create', {
        exitCode: run.code,
        ok: run.json?.ok ?? null,
        error: run.json?.error?.code ?? null,
        // Which fields the old CLI got back, and whether it can name the PTY and process.
        resultFields: Object.keys(terminal).sort(),
        ptyId: labels.pty(
          'ptyId' in terminal && typeof terminal.ptyId === 'string' ? terminal.ptyId : null
        ),
        server: sessionTabsBaseline(listed, labels)
      })
    } finally {
      await host.dispose()
    }
  })
})
