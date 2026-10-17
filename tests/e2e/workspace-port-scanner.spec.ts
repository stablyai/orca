/**
 * E2E coverage for the workspace Ports surfaces.
 *
 * The renderer reads ports from the Zustand store, which the background
 * WorkspacePortScanner fills through `workspacePorts:scan`. These specs override
 * that main-process handler so the real scanner → store → DOM pipeline runs
 * deterministically against stubbed listeners instead of the host's live ports.
 *
 * Covers: the status-bar popover list, advertised-URL reconciliation/update,
 * open-in-browser routing, and the empty state (no spinner).
 */

import { createServer } from 'node:http'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { WorkspacePort, WorkspacePortScanResult } from '../../src/shared/workspace-ports'

type WorkspaceRef = {
  worktreeId: string
  repoId: string
  displayName: string
  path: string
}

// Why: port ids in the real scanner are stable listener keys; the same id across
// two scans is what the aggregate view treats as one (updated) row.
function makeWorkspacePort(args: {
  owner: WorkspaceRef
  port: number
  pid: number
  processName: string
  advertisedUrl?: string
}): WorkspacePort {
  return {
    id: `127.0.0.1:${args.port}:${args.pid}`,
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: args.port,
    pid: args.pid,
    processName: args.processName,
    protocol: 'http',
    kind: 'workspace',
    owner: {
      worktreeId: args.owner.worktreeId,
      repoId: args.owner.repoId,
      displayName: args.owner.displayName,
      path: args.owner.path,
      confidence: 'command'
    },
    ...(args.advertisedUrl ? { advertisedUrl: args.advertisedUrl } : {})
  }
}

function scanWith(ports: WorkspacePort[]): WorkspacePortScanResult {
  return { platform: process.platform, scannedAt: Date.now(), ports }
}

async function readActiveWorkspace(page: Page): Promise<WorkspaceRef> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const worktree = worktrees.find((entry) => entry.id === state.activeWorktreeId) ?? worktrees[0]
    if (!worktree) {
      throw new Error('no worktree available to attribute a stubbed port')
    }
    return {
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      displayName: worktree.displayName,
      path: worktree.path
    }
  })
}

async function stubWorkspacePortScan(
  electronApp: ElectronApplication,
  scan: WorkspacePortScanResult
): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, fixture) => {
    ipcMain.removeHandler('workspacePorts:scan')
    ipcMain.handle('workspacePorts:scan', async () => fixture)
  }, scan)
}

// Why anchored: the accessible name is "Ports, <n> workspace port(s)", which
// distinguishes the status-bar trigger from any plain "Ports" activity-bar tab.
const PORTS_TRIGGER_NAME = /^Ports, /

function portsTrigger(page: Page): Locator {
  return page.getByRole('button', { name: PORTS_TRIGGER_NAME })
}

function popoverContent(page: Page): Locator {
  return page.locator('[data-slot="popover-content"]')
}

/**
 * The background scanner's first scan starts when the renderer mounts, before a
 * spec can replace `workspacePorts:scan`. `scanWorkspacePortsForTarget` dedupes
 * by target, so opening the popover while that scan is still in flight joins it
 * and publishes the host's live ports instead of the stub. Wait for it to settle
 * so the popover's own open refresh starts a fresh scan against the fixture.
 */
async function waitForPortScanSettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          if (!state) {
            return 'no-store'
          }
          return state.workspacePortScanRefreshing ? 'refreshing' : 'settled'
        }),
      { timeout: 45_000, message: 'background workspace port scan did not settle' }
    )
    .toBe('settled')
}

async function openPortsPopover(page: Page): Promise<Locator> {
  await waitForPortScanSettled(page)
  await expect(portsTrigger(page)).toBeVisible()
  await portsTrigger(page).click()
  const popover = popoverContent(page)
  await expect(popover).toBeVisible()
  return popover
}

async function closePortsPopover(page: Page): Promise<void> {
  await portsTrigger(page).click()
  await expect(popoverContent(page)).toHaveCount(0)
}

async function startPortServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>Port E2E</title></head><body>ok</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Port E2E server did not expose a TCP address')
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

test('status bar ports popover lists scanned ports for the active workspace', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const owner = await readActiveWorkspace(orcaPage)
  await stubWorkspacePortScan(
    electronApp,
    scanWith([
      makeWorkspacePort({ owner, port: 4321, pid: 4111, processName: 'vite' }),
      makeWorkspacePort({ owner, port: 5173, pid: 4222, processName: 'node' })
    ])
  )

  const popover = await openPortsPopover(orcaPage)
  await expect(popover.getByText('4321', { exact: true })).toBeVisible()
  await expect(popover.getByText('vite', { exact: true })).toBeVisible()
  await expect(popover.getByText('5173', { exact: true })).toBeVisible()
  await expect(popover.getByText('node', { exact: true })).toBeVisible()
  await expect(popover.getByText('127.0.0.1:4321', { exact: true })).toBeVisible()
})

test('opening a scanned port routes its URL into an Orca browser tab', async ({
  electronApp,
  orcaPage
}) => {
  const server = await startPortServer()
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const owner = await readActiveWorkspace(orcaPage)
    // Why: keep the open action in-app so the spec asserts Orca's routing rather
    // than shelling out to the host's system browser.
    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({ openLinksInApp: true })
    })
    await stubWorkspacePortScan(
      electronApp,
      scanWith([makeWorkspacePort({ owner, port: server.port, pid: 4242, processName: 'node' })])
    )

    const popover = await openPortsPopover(orcaPage)
    const expectedHost = `127.0.0.1:${server.port}`
    await expect(popover.getByText(expectedHost, { exact: true })).toBeVisible()
    await popover.getByRole('button', { name: 'Open in Browser', exact: true }).click()

    const addressBar = orcaPage.locator('[data-orca-browser-address-bar="true"]').first()
    await expect(addressBar).toBeVisible({ timeout: 15_000 })
    await expect(addressBar).toHaveValue(new RegExp(`127\\.0\\.0\\.1:${server.port}`))
  } finally {
    await server.close()
  }
})

test('advertised terminal URLs update the scanned port row without duplicating it', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const owner = await readActiveWorkspace(orcaPage)
  await stubWorkspacePortScan(
    electronApp,
    scanWith([makeWorkspacePort({ owner, port: 4321, pid: 4111, processName: 'vite' })])
  )

  let popover = await openPortsPopover(orcaPage)
  await expect(popover.getByText('127.0.0.1:4321', { exact: true })).toBeVisible()
  await expect(popover.getByText('dev.internal:4321', { exact: true })).toHaveCount(0)

  // Re-scan the same listener now carrying the URL the terminal advertised.
  await closePortsPopover(orcaPage)
  await stubWorkspacePortScan(
    electronApp,
    scanWith([
      makeWorkspacePort({
        owner,
        port: 4321,
        pid: 4111,
        processName: 'vite',
        advertisedUrl: 'http://dev.internal:4321'
      })
    ])
  )

  popover = await openPortsPopover(orcaPage)
  await expect(popover.getByText('dev.internal:4321', { exact: true })).toBeVisible()
  await expect(popover.getByText('127.0.0.1:4321', { exact: true })).toHaveCount(0)
  // Same listener id → the advertised update replaces the row instead of adding one.
  await expect(popover.getByText('4321', { exact: true })).toHaveCount(1)
})

test('an empty scan shows the empty state instead of a spinner', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await stubWorkspacePortScan(electronApp, scanWith([]))

  const popover = await openPortsPopover(orcaPage)
  await expect(popover.getByText('No workspace ports detected', { exact: true })).toBeVisible()
  await expect(popover.getByText('Scanning for workspace ports...', { exact: true })).toHaveCount(0)
  await expect(portsTrigger(orcaPage)).toHaveAttribute('aria-label', 'Ports, 0 workspace ports')
})
