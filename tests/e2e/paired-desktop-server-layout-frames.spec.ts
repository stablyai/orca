// H5b: with ORCA_LAYOUT_OWNER=main, draw the paired server’s layout stream with matching tab/pane ids/order and session-tab bindings across server changes/restart.
import { existsSync, rmSync } from 'node:fs'
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
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  writeRetentionFixture
} from './helpers/host-created-terminal-retention-oracle'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { readPairedPaneContent } from './helpers/paired-host-terminal'
import {
  expectPanesBoundToHandles,
  openTab,
  waitForWorktree
} from './helpers/paired-desktop-server-terminal-tab'
import { expectFrameDrawnTreeMatchesServer } from './helpers/paired-desktop-server-layout'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)
const sinkPath = path.join(scratch, 'server-layout-frames.log')

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Types into the pane showing `leafId`, through its xterm input as a user does. */
async function typeIntoPane(
  page: Page,
  webTabId: string,
  leafId: string,
  text: string
): Promise<void> {
  await page.evaluate(
    ({ webTabId, leafId }) => {
      const manager = window.__paneManagers?.get(webTabId)
      const pane = manager?.getPanes?.().find((entry) => entry.container.dataset.leafId === leafId)
      const input = pane?.container.querySelector('.xterm-helper-textarea')
      if (!pane || !(input instanceof HTMLTextAreaElement)) {
        throw new Error(`pane ${leafId} has no terminal input`)
      }
      pane.terminal.focus()
      input.focus()
    },
    { webTabId, leafId }
  )
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function readPaneText(page: Page, webTabId: string, leafId: string): Promise<string> {
  return page.evaluate(
    ({ webTabId, leafId }) => {
      const pane = window.__paneManagers
        ?.get(webTabId)
        ?.getPanes?.()
        .find((entry) => entry.container.dataset.leafId === leafId)
      return pane?.serializeAddon?.serialize?.() ?? ''
    },
    { webTabId, leafId }
  )
}

test.describe('paired desktop draws a switch-on server from its layout frames', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')

  test('frames draw the server workspace; handles attach; restart and server changes keep it', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(480_000)
    const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
    let client: PairedElectronClient | null = null
    try {
      const status = await host.client.call<{ capabilities?: string[] }>('status.get')
      expect(status.result.capabilities ?? []).toContain(LAYOUT_INTENTS_RUNTIME_CAPABILITY)

      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: 'folder'
      })
      const worktreeId = await waitForWorktree(host, added.result.repo.id)
      const created = await createHostCliTerminal(
        async <TResult>(method: string, params: unknown) =>
          (await host.client.call<TResult>(method, params)).result,
        worktreeId,
        fixturePath,
        sinkPath
      )
      // A second pane, so the pane order is part of what must match.
      await host.client.call('terminal.split', { terminal: created.handle, direction: 'vertical' })
      const hostTabId = created.tabId.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
      const webTabId = toWebTerminalSurfaceTabId(hostTabId)

      client = await launchPairedElectronClient(host.offer, testInfo, 'server-layout-frames')
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
      await openTab(desktop, worktreeId, webTabId)

      let leafIds: string[] = []
      await test.step('frames are the source, and the tree equals the server layout', async () => {
        const tree = await expectFrameDrawnTreeMatchesServer(
          host,
          desktop,
          worktreeId,
          'Desktop never drew the server workspace from frames with the server tree'
        )
        const tab = tree.flatMap((group) => group.tabs).find((entry) => entry.id === webTabId)
        expect(tab?.panes).toHaveLength(2)
        expect(tab?.panes).toContain(created.leafId)
        leafIds = tab!.panes
      })

      await test.step('the terminal works through the session.tabs handle', async () => {
        await expectPanesBoundToHandles(host, desktop, worktreeId, hostTabId, leafIds)
        await typeIntoPane(desktop.page, webTabId, created.leafId, 'H5B_BEFORE_RESTART')
        await expect
          .poll(() => readPaneText(desktop.page, webTabId, created.leafId), { timeout: 30_000 })
          .toContain('LINE:H5B_BEFORE_RESTART')
      })

      await test.step('after a serve restart both sides show the same tree again', async () => {
        await host.restartServeProcess()
        await expectFrameDrawnTreeMatchesServer(
          host,
          desktop,
          worktreeId,
          'After the serve restart the desktop tree never matched the server from frames'
        )
        // The tree, not scrollback: a forced quit can take the dev daemon, and its shell, with it.
        const bound = await expectPanesBoundToHandles(host, desktop, worktreeId, hostTabId, leafIds)
        expect(Object.values(bound).every((ptyId) => ptyId.startsWith('remote:'))).toBe(true)
        await typeIntoPane(desktop.page, webTabId, created.leafId, 'H5B_AFTER_RESTART')
        await expect
          .poll(() => readPairedPaneContent(desktop.page, webTabId), { timeout: 30_000 })
          .toContain('H5B_AFTER_RESTART')
      })

      await test.step('a tab the server creates shows on the desktop from frames', async () => {
        const createdOnServer = await host.client.call<{ tab: { id: string } }>(
          'session.tabs.createTerminal',
          { worktree: `id:${worktreeId}`, activate: false, select: false, navigation: 'caller' }
        )
        const newWebTabId = toWebTerminalSurfaceTabId(
          createdOnServer.result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
        )
        const tree = await expectFrameDrawnTreeMatchesServer(
          host,
          desktop,
          worktreeId,
          'The server-created tab never showed on the desktop from frames'
        )
        expect(tree.flatMap((group) => group.tabs.map((tab) => tab.id))).toContain(newWebTabId)
      })
    } finally {
      await client?.dispose()
      await host.dispose()
    }
  })
})
