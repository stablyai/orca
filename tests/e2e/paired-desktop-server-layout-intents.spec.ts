/**
 * A switch-on desktop paired to a switch-on `orca serve` sends its tab moves on a server workspace
 * to the server's main (H5c-1): a tab drag and a move into a new split change the server's own
 * layout, and the desktop draws the result from the server's frames, never the session.tabs mirror.
 *
 * Run (switch-on build: ORCA_LAYOUT_OWNER=main ... --mode e2e):
 *   SKIP_BUILD=1 pnpm exec playwright test tests/e2e/paired-desktop-server-layout-intents.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=2
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../src/shared/workspace-layout/layout-intents-capability'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  expectFrameDrawnTreeMatchesServer,
  type Tree
} from './helpers/paired-desktop-server-layout'
import { waitForWorktree } from './helpers/paired-desktop-server-terminal-tab'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)
const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function desktopTab(page: Page, webTabId: string) {
  return page.locator(`${SORTABLE_TAB}[data-tab-id="${webTabId}"]`)
}

/** Drops one tab onto the leading edge of another, as a user drags in the tab strip. */
async function dragTab(page: Page, webTabId: string, ontoWebTabId: string): Promise<void> {
  const from = (await desktopTab(page, webTabId).boundingBox())!
  const onto = (await desktopTab(page, ontoWebTabId).boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(onto.x + onto.width * 0.25, onto.y + onto.height / 2, { steps: 8 })
  await page.mouse.up()
}

const tabOrders = (tree: Tree) => tree.map((group) => group.tabs.map((tab) => tab.id))

async function showWorkspace(client: PairedElectronClient, worktreeId: string, webTabId: string) {
  await client.page.evaluate(
    ({ environmentId, worktreeId, webTabId }) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      state.setActiveTab(webTabId)
    },
    { environmentId: client.environmentId, worktreeId, webTabId }
  )
  await expect(desktopTab(client.page, webTabId)).toBeVisible({ timeout: 60_000 })
}

test.describe('paired desktop sends tab moves to a switch-on server’s main', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')

  test('a drag and a move into a split change the server’s layout, drawn from its frames', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    const host = await launchHeadlessPairedRuntimeHost()
    let client: PairedElectronClient | null = null
    try {
      const status = await host.client.call<{ capabilities?: string[] }>('status.get')
      expect(status.result.capabilities ?? []).toContain(LAYOUT_INTENTS_RUNTIME_CAPABILITY)
      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: 'folder'
      })
      const worktreeId = await waitForWorktree(host, added.result.repo.id)
      const tabs: string[] = []
      for (let index = 0; index < 3; index += 1) {
        const created = await host.client.call<{ tab: { id: string } }>(
          'session.tabs.createTerminal',
          { worktree: `id:${worktreeId}`, activate: false, select: false, navigation: 'caller' }
        )
        tabs.push(
          toWebTerminalSurfaceTabId(
            created.result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
          )
        )
      }
      const [first = '', second = '', third = ''] = tabs

      client = await launchPairedElectronClient(host.offer, testInfo, 'server-layout-intents')
      const desktop = client
      await expect
        .poll(
          () =>
            desktop.page.evaluate(
              (id) =>
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .some((worktree) => worktree.id === id) ?? false,
              worktreeId
            ),
          { timeout: 60_000, message: 'Paired desktop never listed the server workspace' }
        )
        .toBe(true)
      await showWorkspace(desktop, worktreeId, first)
      const before = await expectFrameDrawnTreeMatchesServer(
        host,
        desktop,
        worktreeId,
        'Desktop never drew the server workspace from frames'
      )
      expect(tabOrders(before)[0]?.slice(-3)).toEqual([first, second, third])

      await test.step('a tab drag reorders the server’s own layout', async () => {
        await dragTab(desktop.page, third, first)
        await expect
          .poll(
            async () =>
              tabOrders(
                await expectFrameDrawnTreeMatchesServer(
                  host,
                  desktop,
                  worktreeId,
                  'The drag never reached the server’s layout'
                )
              )[0]?.filter((id) => tabs.includes(id)),
            { timeout: 90_000 }
          )
          .toEqual([third, first, second])
      })

      await test.step('a move into a new split moves the tab on the server', async () => {
        await desktopTab(desktop.page, second).click({ button: 'right' })
        await desktop.page.getByRole('menuitem', { name: 'Move Tab to Split' }).hover()
        await desktop.page.getByRole('menuitem', { name: 'Right', exact: true }).click()
        await expect
          .poll(
            async () =>
              tabOrders(
                await expectFrameDrawnTreeMatchesServer(
                  host,
                  desktop,
                  worktreeId,
                  'The split never reached the server’s layout'
                )
              ).find((order) => order.includes(second)),
            { timeout: 90_000 }
          )
          .toEqual([second])
      })
    } finally {
      await client?.dispose()
      await host.dispose()
    }
  })
})
