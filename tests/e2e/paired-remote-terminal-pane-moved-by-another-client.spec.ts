import { randomUUID } from 'node:crypto'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult,
  RuntimeTerminalRead
} from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { splitActiveTerminalPane } from './helpers/terminal'

const PANE = '.pane[data-leaf-id]:visible'

type ClientTabView = { layoutLeaves: string[]; panes: number; ptyId: string | null }

// When another client (a phone, a second desktop, the CLI) moves a pane out of a split, this
// desktop must drop the pane from its source tab, not draw the same live terminal in both tabs.
test('a pane another client moves to a new tab leaves this desktop’s source tab', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'remote pane move')
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
      const listHost = async (): Promise<RuntimeMobileSessionTabsResult> =>
        (
          await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
            worktree
          })
        ).result

      await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
      await expect(page.locator(PANE)).toHaveCount(1, { timeout: 60_000 })
      await waitForBoundPanes(page, 1)
      const sourceTabId = await page.evaluate(() => window.__store?.getState().activeTabId ?? '')
      const firstLeafId = await page.locator(PANE).first().getAttribute('data-leaf-id')
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, 2)
      const movedLeafId = (
        await page
          .locator(PANE)
          .evaluateAll((panes) => panes.map((pane) => pane.getAttribute('data-leaf-id') ?? ''))
      ).find((id) => id !== firstLeafId)
      if (!movedLeafId) {
        throw new Error('The split never mounted a second pane')
      }

      let movedHandle = ''
      let hostSourceTabId = ''
      await expect
        .poll(
          async () => {
            const surface = (await listHost()).tabs.find(
              (tab) => tab.type === 'terminal' && tab.leafId === movedLeafId
            )
            if (surface?.type !== 'terminal' || surface.status !== 'ready') {
              return ''
            }
            hostSourceTabId = surface.parentTabId
            return (movedHandle = surface.terminal)
          },
          { timeout: 30_000 }
        )
        .not.toBe('')
      const readClientTab = (tabId: string): Promise<ClientTabView> =>
        page.evaluate(
          ({ tabId, leafId }) => {
            const layout = window.__store?.getState().terminalLayoutsByTabId[tabId]
            const leaves: string[] = []
            const walk = (node: unknown): void => {
              if (!node || typeof node !== 'object') {
                return
              }
              if ('leafId' in node && typeof node.leafId === 'string') {
                leaves.push(node.leafId)
              }
              if ('first' in node) {
                walk(node.first)
              }
              if ('second' in node) {
                walk(node.second)
              }
            }
            walk(layout?.root)
            return {
              layoutLeaves: leaves.toSorted(),
              panes: window.__paneManagers?.get(tabId)?.getPanes().length ?? 0,
              ptyId: layout?.ptyIdsByLeafId?.[leafId] ?? null
            }
          },
          { tabId, leafId: movedLeafId }
        )
      const movedPtyId = (await readClientTab(sourceTabId)).ptyId
      expect(movedPtyId).not.toBeNull()

      const marker = `ORCA_E2E_MOVED_${randomUUID().slice(0, 8)}`
      await host.client.call('terminal.send', {
        terminal: movedHandle,
        text: `echo ${marker}`,
        enter: true
      })
      const readMovedScrollback = async (): Promise<string> =>
        (
          await host.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
            terminal: movedHandle,
            limit: 50
          })
        ).result.terminal.tail.join('\n')
      await expect.poll(readMovedScrollback, { timeout: 15_000 }).toContain(marker)

      const hostPtyIdOfMovedLeaf = async (): Promise<string | null> =>
        (
          await host.client.call<RuntimeTerminalListResult>('terminal.list', { worktree })
        ).result.terminals.find((terminal) => terminal.leafId === movedLeafId)?.ptyId ?? null
      const hostPtyIdBeforeMove = await hostPtyIdOfMovedLeaf()
      expect(hostPtyIdBeforeMove).not.toBeNull()

      const hostTargetTabId = randomUUID()
      const moved = await host.client.call<{ status: string }>('session.tabs.movePaneToNewTab', {
        worktree,
        sourceTabId: hostSourceTabId,
        targetTabId: hostTargetTabId,
        leafId: movedLeafId
      })
      expect(moved.result.status).toBe('moved')
      const targetTabId = toWebTerminalSurfaceTabId(hostTargetTabId)

      await expect
        .poll(() => readClientTab(targetTabId), {
          timeout: 15_000,
          message: 'this desktop never drew the moved tab'
        })
        .toMatchObject({ layoutLeaves: [movedLeafId], ptyId: movedPtyId })
      await expect
        .poll(() => readClientTab(sourceTabId), {
          timeout: 15_000,
          message: 'the source tab kept the moved pane'
        })
        .toMatchObject({ layoutLeaves: [firstLeafId], panes: 1 })

      // Switching tabs remounts each tab from the store; the duplicate must not come back.
      await page.evaluate((id) => window.__store?.getState().setActiveTab(id), targetTabId)
      await expect(page.locator(PANE)).toHaveCount(1, { timeout: 15_000 })
      await expect(page.locator(`${PANE}[data-leaf-id="${movedLeafId}"]`)).toHaveCount(1)
      await page.evaluate((id) => window.__store?.getState().setActiveTab(id), sourceTabId)
      await expect(page.locator(PANE)).toHaveCount(1, { timeout: 15_000 })
      await expect(page.locator(`${PANE}[data-leaf-id="${movedLeafId}"]`)).toHaveCount(0)
      expect(await readClientTab(sourceTabId)).toMatchObject({
        layoutLeaves: [firstLeafId],
        panes: 1
      })

      // Same terminal: no respawn, and its output from before the move is still there.
      expect(await hostPtyIdOfMovedLeaf()).toBe(hostPtyIdBeforeMove)
      expect(await readMovedScrollback()).toContain(marker)
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
