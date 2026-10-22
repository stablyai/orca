/**
 * A switch-on desktop paired to a switch-on `orca serve` (no window) closes, renames, splits and
 * creates terminals in a server workspace its frames draw (H5c-2). Each lands in the server main's
 * own layout: a close also stops the closed terminal, session.tabs on the server agrees, and the
 * desktop draws every result from the server's frames.
 *
 * Run (switch-on build: ORCA_LAYOUT_OWNER=main ... --mode e2e):
 *   SKIP_BUILD=1 pnpm exec playwright test tests/e2e/paired-desktop-server-layout-writes.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=2
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-terminal-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../src/shared/workspace-layout/layout-intents-capability'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  expectFrameDrawnTreeMatchesServer,
  readServerLayout,
  type Tree
} from './helpers/paired-desktop-server-layout'
import {
  expectPanesBoundToHandles,
  openTab,
  waitForWorktree
} from './helpers/paired-desktop-server-terminal-tab'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

function desktopTab(page: Page, webTabId: string) {
  return page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
}

const terminalTabIds = (tree: Tree) =>
  tree.flatMap((group) => group.tabs.filter((tab) => tab.kind === 'terminal').map((tab) => tab.id))

async function createServerTab(host: HeadlessPairedRuntimeHost, worktreeId: string) {
  const created = await host.client.call<{ tab: { id: string } }>('session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    activate: false,
    select: false,
    navigation: 'caller'
  })
  return toWebTerminalSurfaceTabId(created.result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!)
}

async function serverSessionTabIds(host: HeadlessPairedRuntimeHost, worktreeId: string) {
  const listed = await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  return new Set(
    listed.result.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [toWebTerminalSurfaceTabId(tab.parentTabId)] : []
    )
  )
}

async function serverPtyIdsOfTab(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string,
  hostTabId: string
): Promise<string[]> {
  const listed = await host.client.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${worktreeId}`
  })
  return listed.result.terminals.flatMap((terminal) =>
    terminal.tabId === hostTabId && terminal.ptyId ? [terminal.ptyId] : []
  )
}

async function serverLivePtyIds(host: HeadlessPairedRuntimeHost, worktreeId: string) {
  const listed = await host.client.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${worktreeId}`
  })
  return new Set(listed.result.terminals.flatMap((terminal) => terminal.ptyId ?? []))
}

test.describe('paired desktop writes to a switch-on server’s workspace land in its main', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')

  test('close, rename, split and create change the server’s layout, drawn from its frames', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(360_000)
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
      const kept = await createServerTab(host, worktreeId)
      const closing = await createServerTab(host, worktreeId)

      client = await launchPairedElectronClient(host.offer, testInfo, 'server-layout-writes')
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
      await openTab(desktop, worktreeId, kept)
      const before = await expectFrameDrawnTreeMatchesServer(
        host,
        desktop,
        worktreeId,
        'Desktop never drew the server workspace from frames'
      )
      expect(terminalTabIds(before)).toEqual(expect.arrayContaining([kept, closing]))

      await test.step('a close drops the tab from the server’s layout and stops its terminal', async () => {
        await expect
          .poll(() => serverPtyIdsOfTab(host, worktreeId, toHostSessionTabId(closing)), {
            timeout: 60_000,
            message: 'The server never started the tab’s terminal'
          })
          .not.toEqual([])
        const closedPtyIds = await serverPtyIdsOfTab(host, worktreeId, toHostSessionTabId(closing))
        await desktopTab(desktop.page, closing).hover()
        await desktopTab(desktop.page, closing)
          .locator('[data-tab-close-button="true"]')
          .click({ force: true })
        await expect
          .poll(
            async () =>
              terminalTabIds(
                await expectFrameDrawnTreeMatchesServer(
                  host,
                  desktop,
                  worktreeId,
                  'The close never reached the server’s layout'
                )
              ).includes(closing),
            { timeout: 90_000 }
          )
          .toBe(false)
        await expect
          .poll(async () => (await serverSessionTabIds(host, worktreeId)).has(closing), {
            timeout: 30_000,
            message: 'session.tabs on the server still lists the closed tab'
          })
          .toBe(false)
        await expect
          .poll(
            async () => {
              const live = await serverLivePtyIds(host, worktreeId)
              return closedPtyIds.filter((ptyId) => live.has(ptyId))
            },
            { timeout: 30_000, message: 'The closed tab’s terminal is still running on the server' }
          )
          .toEqual([])
      })

      await test.step('a rename names the tab in the server’s layout', async () => {
        await desktop.page.evaluate(
          (tabId) => window.__store!.getState().setTabCustomTitle(tabId, 'renamed on desktop'),
          kept
        )
        await expect
          .poll(
            async () =>
              (await readServerLayout(host, worktreeId))?.tabs.find(
                (tab) => toWebTerminalSurfaceTabId(tab.entityId) === kept
              )?.customTitle ?? null,
            { timeout: 60_000, message: 'The rename never reached the server’s layout' }
          )
          .toBe('renamed on desktop')
      })

      await test.step('a split adds a pane the server lists and the desktop binds', async () => {
        const [sourceLeaf] =
          (
            await expectFrameDrawnTreeMatchesServer(
              host,
              desktop,
              worktreeId,
              'Desktop lost the tab'
            )
          )
            .flatMap((group) => group.tabs)
            .find((tab) => tab.id === kept)?.panes ?? []
        await desktop.page
          .locator(`.pane[data-leaf-id="${sourceLeaf}"]`)
          .click({ button: 'right', force: true })
        await desktop.page.getByRole('menuitem', { name: /Split Terminal Right/ }).click()
        let leafIds: string[] = []
        await expect
          .poll(
            async () => {
              const tree = await expectFrameDrawnTreeMatchesServer(
                host,
                desktop,
                worktreeId,
                'The split never reached the server’s layout'
              )
              leafIds =
                tree.flatMap((group) => group.tabs).find((tab) => tab.id === kept)?.panes ?? []
              return leafIds.length
            },
            { timeout: 90_000 }
          )
          .toBe(2)
        await expectPanesBoundToHandles(
          host,
          desktop,
          worktreeId,
          toHostSessionTabId(kept),
          leafIds
        )
      })

      await test.step('a new terminal tab is the server’s, listed and bound', async () => {
        const known = new Set(
          terminalTabIds(
            await expectFrameDrawnTreeMatchesServer(
              host,
              desktop,
              worktreeId,
              'Desktop lost the server workspace'
            )
          )
        )
        await desktop.page.getByRole('button', { name: 'New tab' }).click({ force: true })
        await desktop.page
          .getByRole('menuitem', { name: /New Terminal/i })
          .first()
          .click()
        let created = ''
        let leafIds: string[] = []
        await expect
          .poll(
            async () => {
              const tree = await expectFrameDrawnTreeMatchesServer(
                host,
                desktop,
                worktreeId,
                'The new tab never reached the server’s layout'
              )
              const tab = tree
                .flatMap((group) => group.tabs)
                .find((candidate) => candidate.kind === 'terminal' && !known.has(candidate.id))
              created = tab?.id ?? ''
              leafIds = tab?.panes ?? []
              return created !== '' && (await serverSessionTabIds(host, worktreeId)).has(created)
            },
            { timeout: 90_000 }
          )
          .toBe(true)
        await openTab(desktop, worktreeId, created)
        await expectPanesBoundToHandles(
          host,
          desktop,
          worktreeId,
          toHostSessionTabId(created),
          leafIds
        )
      })
    } finally {
      await client?.dispose()
      await host.dispose()
    }
  })
})
