// Throwaway interactive preview (untracked): shows the client-hosted browser
// intro tooltip in a headed paired client and holds the app open for review.
// Run: ORCA_TOOLTIP_PREVIEW=1 pnpm exec playwright test --config tests/playwright.config.ts \
//   --project electron-headless --workers=1 tests/e2e/client-hosted-browser-tooltip-preview.spec.ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'

test.skip(process.env.ORCA_TOOLTIP_PREVIEW !== '1', 'Preview only; run with ORCA_TOOLTIP_PREVIEW=1')

const HOLD_MINUTES = 20

async function startFixtureServer(): Promise<{ close(): Promise<void>; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><html><head><title>tooltip-preview</title></head><body style="font-family:sans-serif;padding:2rem"><h1>Client-hosted page</h1><p>The intro tooltip should point at the controls above.</p></body></html>'
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
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/preview`
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function findPairedWorktreeId(page: Page, repoPath: string): Promise<string> {
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
    .poll(read, { timeout: 60_000, message: 'paired client never received the host worktree' })
    .not.toBeNull()
  const worktreeId = await read()
  if (!worktreeId) {
    throw new Error('Paired worktree disappeared after discovery')
  }
  return worktreeId
}

test('shows the client-hosted browser intro tooltip and holds for review', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout((HOLD_MINUTES + 10) * 60_000)
  const fixtureServer = await startFixtureServer()
  const host = await launchHeadlessPairedRuntimeHost()
  let dispose = async (): Promise<void> => {
    await host.dispose()
    await fixtureServer.close()
  }
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Preview Terminal'
    })
    const client = await launchPairedElectronClient(host.offer, testInfo, 'tooltip preview')
    const disposeWithoutClient = dispose
    dispose = async () => {
      await client.dispose()
      await disposeWithoutClient()
    }

    // The e2e profile launches hidden; surface the window for the human.
    await client.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setSize(1440, 900)
      window?.center()
      window?.show()
      window?.focus()
    })

    const worktreeId = await findPairedWorktreeId(client.page, testRepoPath)
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await expect
      .poll(
        (): Promise<number> =>
          client.page.evaluate(
            (id) => window.__store?.getState().groupsByWorktree[id]?.[0]?.tabOrder.length ?? 0,
            worktreeId
          ),
        { timeout: 120_000, message: 'paired client never adopted the host tab group' }
      )
      .toBeGreaterThanOrEqual(1)

    await client.page.evaluate(
      async ({ url, worktreeId }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('store unavailable')
        }
        const groupId = state.groupsByWorktree[worktreeId]?.[0]?.id
        state.setBrowserDefaultUrl(url)
        await state.openNewBrowserTabInActiveWorkspace(groupId)
      },
      { url: fixtureServer.url, worktreeId }
    )

    await expect
      .poll(
        (): Promise<string | null> =>
          client.page.evaluate(() => window.__store?.getState().activeContextualTourId ?? null),
        { timeout: 60_000, message: 'intro tooltip never became the active contextual tour' }
      )
      .toBe('client-hosted-browser')

    console.log(`\n=== TOOLTIP PREVIEW READY — window stays up ${HOLD_MINUTES} minutes ===\n`)
    await new Promise((resolve) => setTimeout(resolve, HOLD_MINUTES * 60_000))
  } finally {
    await dispose()
  }
})
