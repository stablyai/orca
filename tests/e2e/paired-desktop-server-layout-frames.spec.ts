/**
 * A switch-on desktop paired to a switch-on `orca serve` draws the server's workspace from the
 * server's layout stream (H5b), not the session.tabs mirror: its tree equals the server's own by
 * tab and pane ids and order, its terminal panes bind the session.tabs handle, and both hold
 * through a serve restart and a layout change made on the server's side.
 *
 * Run (switch-on build: ORCA_LAYOUT_OWNER=main ... --mode e2e):
 *   pnpm exec playwright test tests/e2e/paired-desktop-server-layout-frames.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=2
 */
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { pairedRuntimeConnectionFromOffer } from '../../src/shared/paired-runtime-connection'
import { decodePairingOffer } from '../../src/shared/pairing'
import { subscribeRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../src/shared/workspace-layout/layout-intents-capability'
import type { PublishedWorkspaceLayout } from '../../src/shared/workspace-layout/workspace-layout-published'
import { readWorkspaceLayoutStreamFrame } from '../../src/shared/workspace-layout/workspace-layout-stream-frames'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
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
import { leafIdsInOrder } from './helpers/workspace-layout-oracle-model'
import {
  expectPanesBoundToHandles,
  openTab,
  waitForWorktree
} from './helpers/paired-desktop-server-terminal-tab'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

/** Groups in order, each tab in tab order with its pane ids in tree order. */
type Tree = { id: string; tabs: { id: string; kind: string; panes: string[] }[] }[]

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)
const sinkPath = path.join(scratch, 'server-layout-frames.log')

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The server's own layout of the workspace: the first snapshot of a stream of the test's own. */
async function readServerLayout(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<PublishedWorkspaceLayout | null> {
  let resolveSnapshot: (value: unknown) => void = () => {}
  const snapshot = new Promise<unknown>((resolve) => {
    resolveSnapshot = resolve
  })
  const subscription = await subscribeRemoteRuntimeRequest<unknown>(
    pairedRuntimeConnectionFromOffer(decodePairingOffer(host.offer.pairingUrl)),
    'layout.subscribe',
    { workspaces: [worktreeId] },
    30_000,
    {
      onResponse: (response) => resolveSnapshot(response.ok ? response.result : null),
      onError: () => resolveSnapshot(null),
      onClose: () => resolveSnapshot(null)
    }
  )
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
    const frame = readWorkspaceLayoutStreamFrame(await Promise.race([snapshot, timeout]))
    if (frame?.type !== 'snapshot') {
      return null
    }
    return frame.workspaces.find((entry) => entry.key === worktreeId)?.layout ?? null
  } finally {
    subscription.close()
  }
}

/** The server's tree under the ids the desktop gives it: a terminal tab is named by its terminal. */
function serverTree(layout: PublishedWorkspaceLayout | null): Tree | null {
  if (!layout) {
    return null
  }
  const tabsById = new Map(layout.tabs.map((tab) => [tab.id, tab]))
  return layout.groups.map((group) => ({
    id: group.id,
    tabs: group.tabIds.map((tabId) => {
      const tab = tabsById.get(tabId)
      if (!tab) {
        return { id: tabId, kind: 'missing', panes: [] }
      }
      const terminal = tab.kind === 'terminal'
      return {
        id: terminal ? toWebTerminalSurfaceTabId(tab.entityId) : tab.id,
        kind: tab.kind,
        panes: terminal ? leafIdsInOrder(tab.terminal?.root) : []
      }
    })
  }))
}

async function desktopTree(page: Page, worktreeId: string): Promise<Tree> {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    const tabs = state.unifiedTabsByWorktree[id] ?? []
    type Node = { type: 'leaf'; leafId: string } | { type: 'split'; first: Node; second: Node }
    const leaves = (node: Node | null | undefined): string[] =>
      !node
        ? []
        : node.type === 'leaf'
          ? [node.leafId]
          : [...leaves(node.first), ...leaves(node.second)]
    return (state.groupsByWorktree[id] ?? []).map((group) => ({
      id: group.id,
      tabs: group.tabOrder.map((tabId) => {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) {
          return { id: tabId, kind: 'missing', panes: [] }
        }
        return {
          id: tab.id,
          kind: tab.contentType,
          panes:
            tab.contentType === 'terminal'
              ? leaves(state.terminalLayoutsByTabId[tab.entityId]?.root)
              : []
        }
      })
    }))
  }, worktreeId)
}

/** True when frames draw it; else what the desktop knows of the server, for the failure message. */
async function isFrameDrawn(
  client: PairedElectronClient,
  worktreeId: string
): Promise<true | { hook: boolean; verification: unknown; layoutIntents: string[] }> {
  return client.page.evaluate(
    ({ environmentId, worktreeId }) => {
      const hook = window.__isFrameDrawnServerWorkspaceE2E
      if (hook?.(environmentId, worktreeId)) {
        return true
      }
      const status = window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)
      const capabilities = status?.snapshot?.status?.capabilities ?? []
      return {
        hook: hook !== undefined,
        verification: status?.snapshot?.verification ?? null,
        layoutIntents: capabilities.filter((entry) => entry.startsWith('layout'))
      }
    },
    { environmentId: client.environmentId, worktreeId }
  )
}

/** Polls until the workspace is frame-drawn and both trees agree three reads in a row. */
async function expectFrameDrawnTreeMatchesServer(
  host: HeadlessPairedRuntimeHost,
  client: PairedElectronClient,
  worktreeId: string,
  message: string
): Promise<Tree> {
  let streak = 0
  let settled: Tree | null = null
  await expect
    .poll(
      async () => {
        const [server, desktop, frameDrawn] = await Promise.all([
          readServerLayout(host, worktreeId).then(serverTree),
          desktopTree(client.page, worktreeId),
          isFrameDrawn(client, worktreeId)
        ])
        const match =
          frameDrawn === true &&
          server !== null &&
          JSON.stringify(server) === JSON.stringify(desktop)
        streak = match ? streak + 1 : 0
        settled = match ? server : null
        return streak >= 3 ? 'settled' : { frameDrawn, server, desktop }
      },
      { timeout: 90_000, intervals: [500], message }
    )
    .toBe('settled')
  return settled!
}

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
