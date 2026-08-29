import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './headless-paired-runtime-host'
import { launchPairedElectronClient, type PairedElectronClient } from './paired-electron-client'

export type PaneGroup = {
  activeTabId: string | null
  id: string
  tabOrder: string[]
}

export type PaneSnapshot = {
  activeGroupId: string | null
  groups: PaneGroup[]
  layoutGroupIds: string[]
  tabs: { contentType: string; entityId: string; groupId: string; id: string; label: string }[]
}

export type PairedFixture = {
  client: PairedElectronClient
  dispose(): Promise<void>
  host: HeadlessPairedRuntimeHost
  rootGroupId: string
  terminalHandles: string[]
  url: string
  worktreeId: string
}

export async function startPlacementFixtureServer(): Promise<{
  close(): Promise<void>
  url: string
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(
      '<!doctype html><html><head><title>placement-marker</title></head><body><h1 id="marker">placement-marker</h1></body></html>'
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    close: () => closeServer(server),
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/placement`
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function findPairedWorktreeId(page: Page, repoPath: string): Promise<string> {
  const read = () =>
    page.evaluate(
      (path) =>
        window.__store
          ?.getState()
          .allWorktrees()
          .find((worktree) => worktree.path === path)?.id ?? null,
      repoPath
    )
  await expect
    .poll(read, {
      timeout: 60_000,
      message: 'paired client never received the host worktree'
    })
    .not.toBeNull()
  const worktreeId = await read()
  if (!worktreeId) {
    throw new Error('Paired worktree disappeared after discovery')
  }
  return worktreeId
}

export async function readPanes(page: Page, worktreeId: string): Promise<PaneSnapshot> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    const layoutGroupIds: string[] = []
    const visitLayout = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return
      }
      const leaf = node as { groupId?: string; type?: string }
      if (leaf.type === 'leaf' && leaf.groupId) {
        layoutGroupIds.push(leaf.groupId)
        return
      }
      const split = node as { first?: unknown; second?: unknown }
      visitLayout(split.first)
      visitLayout(split.second)
    }
    visitLayout(state?.layoutByWorktree[id] ?? null)
    return {
      activeGroupId: state?.activeGroupIdByWorktree[id] ?? null,
      groups: (state?.groupsByWorktree[id] ?? []).map((group) => ({
        activeTabId: group.activeTabId ?? null,
        id: group.id,
        tabOrder: [...group.tabOrder]
      })),
      layoutGroupIds,
      tabs: (state?.unifiedTabsByWorktree[id] ?? []).map((tab) => ({
        contentType: tab.contentType,
        entityId: tab.entityId,
        groupId: tab.groupId,
        id: tab.id,
        label: tab.label
      }))
    }
  }, worktreeId)
}

export function requireGroup(panes: PaneSnapshot, groupId: string): PaneGroup {
  const group = panes.groups.find((candidate) => candidate.id === groupId)
  if (!group) {
    throw new Error(`Group ${groupId} missing from ${JSON.stringify(panes)}`)
  }
  return group
}

export function contentTypesOf(panes: PaneSnapshot, groupId: string): string[] {
  return requireGroup(panes, groupId).tabOrder.map(
    (tabId) => panes.tabs.find((tab) => tab.id === tabId)?.contentType ?? 'missing'
  )
}

export async function waitForGroupTabCount(
  page: Page,
  worktreeId: string,
  groupId: string,
  count: number,
  message: string
): Promise<PaneSnapshot> {
  try {
    await expect
      .poll(
        async () => {
          const panes = await readPanes(page, worktreeId)
          return panes.groups.find((group) => group.id === groupId)?.tabOrder.length ?? -1
        },
        { timeout: 90_000, message }
      )
      .toBe(count)
  } catch (error) {
    // Why: placement bugs land the tab in the wrong pane, so the whole pane model is the evidence.
    throw new Error(
      `${message} (group ${groupId}); panes=${JSON.stringify(await readPanes(page, worktreeId))}`,
      { cause: error }
    )
  }
  return readPanes(page, worktreeId)
}

/** Rename a host terminal and wait for the client to apply the resulting snapshot. */
export async function pushHostSnapshot(
  fixture: PairedFixture,
  terminalHandle: string,
  title: string
): Promise<void> {
  await fixture.host.client.call('terminal.rename', {
    terminal: terminalHandle,
    title
  })
  await expect
    .poll(
      async () => {
        const panes = await readPanes(fixture.client.page, fixture.worktreeId)
        return panes.tabs.some((tab) => tab.label.includes(title))
      },
      {
        timeout: 90_000,
        message: `client never applied the snapshot renaming to "${title}"`
      }
    )
    .toBe(true)
}

export async function openRemoteBrowserTab(
  page: Page,
  url: string,
  groupId: string
): Promise<void> {
  await page.evaluate(
    async ({ groupId, url }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired client store unavailable')
      }
      state.setBrowserDefaultUrl(url)
      await state.openNewBrowserTabInActiveWorkspace(groupId)
    },
    { groupId, url }
  )
}

export async function setUpPairedFixture(
  testInfo: TestInfo,
  repoPath: string
): Promise<PairedFixture> {
  const fixtureServer = await startPlacementFixtureServer()
  let host: HeadlessPairedRuntimeHost | null = null
  let client: PairedElectronClient | null = null
  try {
    host = await launchHeadlessPairedRuntimeHost()
    await host.client.call('repo.add', { path: repoPath, kind: 'git' })
    const terminalHandles: string[] = []
    for (const title of ['Placement Alpha', 'Placement Beta']) {
      const created = await host.client.call<{ terminal: { handle: string } }>('terminal.create', {
        worktree: `path:${repoPath}`,
        title
      })
      terminalHandles.push(created.result.terminal.handle)
    }
    client = await launchPairedElectronClient(host.offer, testInfo, 'STA-4150 split-pane placement')
    const worktreeId = await findPairedWorktreeId(client.page, repoPath)
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    // Why: placement only becomes client-owned once the client holds groups, so wait for adoption.
    await expect
      .poll(
        async () => {
          const panes = await readPanes(client!.page, worktreeId)
          const group = panes.groups[0]
          if (!group) {
            return 0
          }
          return group.tabOrder.filter(
            (tabId) => panes.tabs.find((tab) => tab.id === tabId)?.contentType === 'terminal'
          ).length
        },
        {
          timeout: 120_000,
          message: 'paired client never materialized both host terminals'
        }
      )
      .toBeGreaterThanOrEqual(2)
    const panes = await readPanes(client.page, worktreeId)
    const rootGroupId = panes.groups[0]?.id
    if (!rootGroupId) {
      throw new Error('Paired worktree has no tab group after adoption')
    }
    const resolvedHost = host
    const resolvedClient = client
    return {
      client: resolvedClient,
      dispose: async () => {
        await resolvedClient.dispose()
        await resolvedHost.dispose()
        await fixtureServer.close()
      },
      host: resolvedHost,
      rootGroupId,
      terminalHandles,
      url: fixtureServer.url,
      worktreeId
    }
  } catch (error) {
    await client?.dispose()
    await host?.dispose()
    await fixtureServer.close()
    throw error
  }
}
