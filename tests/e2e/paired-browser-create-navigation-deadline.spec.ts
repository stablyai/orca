import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const OPERATION_ID = 'sta-4231-owner-pinned-navigation-hold'

type HeldNavigationServer = {
  close: () => Promise<void>
  pendingCount: () => number
  release: () => void
  url: string
}

type CreateOutcome = {
  error: string | null
  ok: boolean
  pageId: string | null
}

async function startHeldNavigationServer(): Promise<HeldNavigationServer> {
  const pending = new Set<ServerResponse>()
  const server: Server = createServer((_request, response) => {
    pending.add(response)
    response.once('close', () => pending.delete(response))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  const release = (): void => {
    for (const response of pending) {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html><body>released</body></html>')
      }
    }
    pending.clear()
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        release()
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    pendingCount: () => pending.size,
    release,
    url: `http://127.0.0.1:${port}/hold?operation=${OPERATION_ID}`
  }
}

async function readHostBrowserPageIds(
  hostClient: RuntimeClient,
  worktreeId: string
): Promise<string[]> {
  const response = await hostClient.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  return response.result.tabs.flatMap((tab) =>
    tab.type === 'browser' && tab.browserPageId ? [tab.browserPageId] : []
  )
}

async function createOwnerPinnedBrowser(
  page: Page,
  environmentId: string,
  worktreeId: string,
  url: string
): Promise<CreateOutcome> {
  return page.evaluate(
    async ({ environmentId, url, worktreeId }) => {
      try {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'browser.tabCreate',
          params: {
            activate: true,
            url,
            waitForRegistration: true,
            worktree: `id:${worktreeId}`
          },
          timeoutMs: 15_000
        })
        if (!response.ok) {
          return {
            error: `${response.error.code}: ${response.error.message}`,
            ok: false,
            pageId: null
          }
        }
        const result = response.result as { browserPageId: string }
        return { error: null, ok: true, pageId: result.browserPageId }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
          pageId: null
        }
      }
    },
    { environmentId, url, worktreeId }
  )
}

async function findPairedWorktreeId(
  client: PairedElectronClient,
  repoPath: string
): Promise<string> {
  const worktreeId = await expect
    .poll(
      () =>
        client.page.evaluate(
          (path) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.path === path)?.id ?? null,
          repoPath
        ),
      { timeout: 60_000, message: 'paired client never received the host worktree' }
    )
    .not.toBeNull()
    .then(() =>
      client.page.evaluate(
        (path) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.path === path)?.id ?? null,
        repoPath
      )
    )
  if (!worktreeId) {
    throw new Error('Paired worktree disappeared after discovery')
  }
  return worktreeId
}

test('returns a headed host page identity before owner-pinned navigation can time out @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(300_000)
  const fixture = await startHeldNavigationServer()
  let client: PairedElectronClient | null = null
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const hostClient = new RuntimeClient(userDataDir, 5_000)
    client = await launchPairedElectronClient(offer, testInfo, 'STA-4231 navigation deadline')
    const worktreeId = await findPairedWorktreeId(client, testRepoPath)
    const baselineHostPageIds = await readHostBrowserPageIds(hostClient, worktreeId)
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )

    const firstPromise = createOwnerPinnedBrowser(
      client.page,
      client.environmentId,
      worktreeId,
      fixture.url
    )
    await expect.poll(fixture.pendingCount, { timeout: 30_000 }).toBe(1)
    const firstHostPageId = await expect
      .poll(async () => {
        const ids = await readHostBrowserPageIds(hostClient, worktreeId)
        return ids.find((id) => !baselineHostPageIds.includes(id)) ?? null
      })
      .not.toBeNull()
      .then(async () => {
        const ids = await readHostBrowserPageIds(hostClient, worktreeId)
        return ids.find((id) => !baselineHostPageIds.includes(id)) ?? null
      })
    const first = await firstPromise

    let retry: CreateOutcome | null = null
    if (!first.ok) {
      const retryPromise = createOwnerPinnedBrowser(
        client.page,
        client.environmentId,
        worktreeId,
        fixture.url
      )
      await expect.poll(fixture.pendingCount, { timeout: 30_000 }).toBe(2)
      retry = await retryPromise
    }
    const hostPageIds = (await readHostBrowserPageIds(hostClient, worktreeId)).filter(
      (id) => !baselineHostPageIds.includes(id)
    )

    expect({ first, firstHostPageId, hostPageIds, retry }).toEqual({
      first: { error: null, ok: true, pageId: firstHostPageId },
      firstHostPageId,
      hostPageIds: [firstHostPageId],
      retry: null
    })
  } finally {
    fixture.release()
    await client?.dispose()
    await fixture.close()
  }
})
