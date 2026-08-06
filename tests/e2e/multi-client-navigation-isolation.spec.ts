import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { worktreeRow, worktreeRowSurface } from './worktree-row-locators'

type RuntimePairingOffer = {
  deviceId: string
  webClientUrl: string
}

type TestWorktreeIds = {
  host: string
  clientA: string
  clientB: string
  clientA2: string
}

const isPairedBrowserRun = process.env.ORCA_E2E_WEB_CLIENT === '1'

test.skip(
  !isPairedBrowserRun,
  'Run with pnpm test:e2e:multi-client-navigation so the paired web client is built'
)

function addGitWorktree(repoPath: string, branchName: string): void {
  const worktreePath = path.join(path.dirname(repoPath), `e2e-test-${branchName}`)
  execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], {
    cwd: repoPath,
    stdio: 'pipe'
  })
}

async function loadTestWorktreeIds(
  hostPage: Page,
  branchA: string,
  branchB: string
): Promise<TestWorktreeIds | null> {
  return hostPage.evaluate(
    async ({ branchA, branchB }) => {
      const store = window.__store
      if (!store) {
        return null
      }
      const repo = store.getState().repos[0]
      if (!repo) {
        return null
      }
      await store.getState().fetchWorktrees(repo.id)
      const worktrees = store.getState().worktreesByRepo[repo.id] ?? []
      const host = worktrees.find((worktree) => worktree.branch === 'refs/heads/e2e-secondary')
      const clientA = worktrees.find((worktree) => worktree.branch === `refs/heads/${branchA}`)
      const clientB = worktrees.find((worktree) => worktree.branch === `refs/heads/${branchB}`)
      const clientA2 = worktrees.find((worktree) => worktree.isMainWorktree)
      if (!host || !clientA || !clientB || !clientA2) {
        return null
      }
      return {
        host: host.id,
        clientA: clientA.id,
        clientB: clientB.id,
        clientA2: clientA2.id
      }
    },
    { branchA, branchB }
  )
}

async function createPairingOffer(hostPage: Page): Promise<RuntimePairingOffer> {
  return hostPage.evaluate(async () => {
    const offer = await window.api.mobile.getRuntimePairingUrl({
      address: '127.0.0.1',
      rotate: true
    })
    if (!offer.available || !offer.webClientUrl) {
      const reason = offer.available ? 'web client URL is missing' : 'runtime server is unavailable'
      throw new Error(`Runtime web client pairing failed: ${reason}`)
    }
    return { deviceId: offer.deviceId, webClientUrl: offer.webClientUrl }
  })
}

async function openPairedClient(
  electronApp: ElectronApplication,
  offer: RuntimePairingOffer,
  visibleWorktreeId: string
): Promise<Page> {
  const pagePromise = electronApp.waitForEvent('window')
  await electronApp.evaluate(
    async ({ BrowserWindow }, { partition, url }) => {
      const clientWindow = new BrowserWindow({
        height: 1200,
        show: false,
        width: 1440,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          sandbox: true
        }
      })
      await clientWindow.loadURL(url)
    },
    {
      partition: `e2e-paired-client-${randomUUID()}`,
      url: offer.webClientUrl
    }
  )
  const page = await pagePromise
  await expect(page.locator('[data-worktree-sidebar]')).toBeVisible({ timeout: 30_000 })
  await expect(worktreeRow(page, visibleWorktreeId)).toBeVisible({ timeout: 30_000 })
  return page
}

async function selectWorktree(page: Page, worktreeId: string): Promise<void> {
  await worktreeRowSurface(page, worktreeId).click()
  await expectActiveWorktree(page, worktreeId)
}

async function expectActiveWorktree(page: Page, worktreeId: string): Promise<void> {
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktreeId
  )
}

test('keeps two paired browser clients and the host on independent worktrees', async ({
  orcaPage,
  electronApp,
  testRepoPath
}) => {
  const suffix = randomUUID().slice(0, 8)
  const branchA = `e2e-client-a-${suffix}`
  const branchB = `e2e-client-b-${suffix}`
  addGitWorktree(testRepoPath, branchA)
  addGitWorktree(testRepoPath, branchB)

  await expect
    .poll(() => loadTestWorktreeIds(orcaPage, branchA, branchB), {
      timeout: 30_000,
      message: 'Expected host plus three client-selectable worktrees'
    })
    .not.toBeNull()

  // Playwright's matcher does not narrow the polled value for TypeScript.
  const ids = await loadTestWorktreeIds(orcaPage, branchA, branchB)
  if (!ids) {
    throw new Error('Test worktrees disappeared after discovery')
  }

  await selectWorktree(orcaPage, ids.host)

  let clientA: Page | null = null
  let clientB: Page | null = null
  try {
    const offerA = await createPairingOffer(orcaPage)
    clientA = await openPairedClient(electronApp, offerA, ids.clientA)
    await selectWorktree(clientA, ids.clientA)

    // Why: rotation preserves used grants, so B is issued only after A has completed pairing.
    const offerB = await createPairingOffer(orcaPage)
    expect(offerB.deviceId).not.toBe(offerA.deviceId)
    clientB = await openPairedClient(electronApp, offerB, ids.clientB)
    await selectWorktree(clientB, ids.clientB)

    await expectActiveWorktree(clientA, ids.clientA)
    await expectActiveWorktree(orcaPage, ids.host)

    await selectWorktree(clientA, ids.clientA2)

    await expectActiveWorktree(clientB, ids.clientB)
    await expectActiveWorktree(orcaPage, ids.host)
  } finally {
    await clientB?.close()
    await clientA?.close()
  }
})
