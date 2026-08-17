import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_NAME = 'paired-browser-reconcile-failure.html'

type FaultSnapshot = {
  armed: boolean
  capabilityRejectionArmed: boolean
  createdPageId: string | null
  suppressedPageIds: string[]
}

type FaultWindow = Window & {
  __webRuntimeBrowserCreationFault?: {
    arm: () => void
    armCapabilityRejection: () => void
    release: () => boolean
    reset: () => void
    snapshot: () => FaultSnapshot
  }
}

type ClientTabState = {
  browserTabIds: string[]
  browserWorkspaceIds: string[]
  editorTabIds: string[]
  groupIds: string[]
  terminalTabIds: string[]
}

async function readHostTabs(
  hostClient: RuntimeClient,
  repoPath: string
): Promise<RuntimeMobileSessionTabsResult> {
  const response = await hostClient.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `path:${repoPath}`
  })
  return response.result
}

async function readClientTabs(page: Page, worktreeId: string): Promise<ClientTabState> {
  return page.evaluate((targetWorktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Paired client store unavailable')
    }
    const unifiedTabs = state.unifiedTabsByWorktree[targetWorktreeId] ?? []
    return {
      browserTabIds: unifiedTabs
        .filter((tab) => tab.contentType === 'browser')
        .map((tab) => tab.id),
      browserWorkspaceIds: (state.browserTabsByWorktree[targetWorktreeId] ?? []).map(
        (workspace) => workspace.id
      ),
      editorTabIds: unifiedTabs.filter((tab) => tab.contentType === 'editor').map((tab) => tab.id),
      groupIds: (state.groupsByWorktree[targetWorktreeId] ?? []).map((group) => group.id),
      terminalTabIds: unifiedTabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => tab.id)
    }
  }, worktreeId)
}

async function runReconciliationFailureJourney(args: {
  hostClient: RuntimeClient
  offer: RuntimeDesktopPairingOffer
  repoPath: string
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(
      args.offer,
      args.testInfo,
      `${args.topology} browser reconciliation failure`
    )
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    const page = client.page
    const worktreeId = await expect
      .poll(
        () =>
          page.evaluate((repoPath) => {
            const state = window.__store?.getState()
            return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
          }, args.repoPath),
        { timeout: 60_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate((repoPath) => {
          const state = window.__store?.getState()
          return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
        }, args.repoPath)
      )
    if (!worktreeId) {
      throw new Error('Paired client worktree disappeared after discovery')
    }
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 60_000,
        message: 'paired client did not materialize the host terminal'
      })
      .toMatchObject({ terminalTabIds: expect.arrayContaining([expect.any(String)]) })

    await openFileExplorer(page)
    const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: FIXTURE_NAME })
    await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
    await fixtureRow.click()
    const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
    const baselineClient = await readClientTabs(page, worktreeId)
    expect(baselineClient.editorTabIds).not.toHaveLength(0)
    expect(baselineClient.terminalTabIds).not.toHaveLength(0)
    const baselineHost = await readHostTabs(args.hostClient, args.repoPath)
    const baselineHostBrowserIds = baselineHost.tabs
      .filter((tab) => tab.type === 'browser')
      .map((tab) => tab.browserPageId)

    await page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser reconciliation E2E fault seam unavailable')
      }
      fault.arm()
    })
    await openPreviewToSide.click()

    const faultSnapshot = await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
          ),
        { timeout: 30_000, message: 'host browser creation never reached the held fault seam' }
      )
      .toMatchObject({ armed: true, createdPageId: expect.any(String) })
      .then(() =>
        page.evaluate(
          () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
        )
      )
    const createdPageId = faultSnapshot?.createdPageId
    if (!createdPageId) {
      throw new Error('Held browser creation did not expose its exact host page id')
    }

    const heldHost = await readHostTabs(args.hostClient, args.repoPath)
    expect(
      heldHost.tabs.some((tab) => tab.type === 'browser' && tab.browserPageId === createdPageId)
    ).toBe(true)
    const heldClient = await readClientTabs(page, worktreeId)
    expect(heldClient.browserTabIds).toEqual(baselineClient.browserTabIds)
    expect(heldClient.browserWorkspaceIds).toEqual(baselineClient.browserWorkspaceIds)
    expect(heldClient.editorTabIds).toEqual(baselineClient.editorTabIds)
    expect(heldClient.terminalTabIds).toEqual(baselineClient.terminalTabIds)
    expect(heldClient.groupIds).toHaveLength(baselineClient.groupIds.length + 1)

    await page.screenshot({
      path: args.testInfo.outputPath(`${args.topology}-browser-reconciliation-held.png`),
      fullPage: true
    })
    expect(
      await page.evaluate(
        () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.release() ?? false
      )
    ).toBe(true)

    await expect(page.getByText('Unable to open this file in Orca Browser.')).toBeVisible({
      timeout: 30_000
    })
    await expect
      .poll(
        async () => {
          const snapshot = await readHostTabs(args.hostClient, args.repoPath)
          return snapshot.tabs.some(
            (tab) => tab.type === 'browser' && tab.browserPageId === createdPageId
          )
        },
        { timeout: 30_000, message: 'rollback did not close the exact host browser page' }
      )
      .toBe(false)
    const settledClient = await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 30_000,
        message: 'client split and browser state did not settle after rollback'
      })
      .toMatchObject({
        browserTabIds: baselineClient.browserTabIds,
        browserWorkspaceIds: baselineClient.browserWorkspaceIds,
        editorTabIds: baselineClient.editorTabIds,
        groupIds: baselineClient.groupIds,
        terminalTabIds: baselineClient.terminalTabIds
      })
      .then(() => readClientTabs(page, worktreeId))
    expect(settledClient).toEqual(baselineClient)
    expect(
      (await readHostTabs(args.hostClient, args.repoPath)).tabs
        .filter((tab) => tab.type === 'browser')
        .map((tab) => tab.browserPageId)
    ).toEqual(baselineHostBrowserIds)
    await page.evaluate(() => (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset())
  } finally {
    await client?.dispose()
  }
}

async function runCapabilityFailureJourney(args: {
  hostClient: RuntimeClient
  offer: RuntimeDesktopPairingOffer
  repoPath: string
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(
      args.offer,
      args.testInfo,
      `${args.topology} browser capability failure`
    )
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    const page = client.page
    const worktreeId = await expect
      .poll(
        () =>
          page.evaluate((repoPath) => {
            const state = window.__store?.getState()
            return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
          }, args.repoPath),
        { timeout: 60_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate((repoPath) => {
          const state = window.__store?.getState()
          return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
        }, args.repoPath)
      )
    if (!worktreeId) {
      throw new Error('Paired client worktree disappeared after discovery')
    }
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 60_000,
        message: 'paired client did not materialize the host terminal'
      })
      .toMatchObject({ terminalTabIds: expect.arrayContaining([expect.any(String)]) })

    await openFileExplorer(page)
    const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: FIXTURE_NAME })
    await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
    await fixtureRow.click()
    const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
    const baselineClient = await readClientTabs(page, worktreeId)
    const baselineHost = await readHostTabs(args.hostClient, args.repoPath)

    await page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser capability E2E fault seam unavailable')
      }
      fault.armCapabilityRejection()
    })
    await openPreviewToSide.click()

    await expect(page.getByText('Unable to open this file in Orca Browser.')).toBeVisible({
      timeout: 30_000
    })
    await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 30_000,
        message: 'client split state did not settle after capability rejection'
      })
      .toEqual(baselineClient)
    expect(await readHostTabs(args.hostClient, args.repoPath)).toEqual(baselineHost)
    await page.screenshot({
      path: args.testInfo.outputPath(`${args.topology}-browser-capability-rejected.png`),
      fullPage: true
    })
    await page.evaluate(() => (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset())
  } finally {
    await client?.dispose()
  }
}

test('rolls back a headed-host browser when client reconciliation times out @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    '<!doctype html><html><body><h1>browser reconciliation fault</h1></body></html>\n'
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await runReconciliationFailureJourney({
    hostClient: new RuntimeClient(userDataDir, 5_000),
    offer,
    repoPath: testRepoPath,
    testInfo,
    topology: 'headed'
  })
})

test('cleans up a headed-host preview when capability rejects after preflight @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    '<!doctype html><html><body><h1>browser capability fault</h1></body></html>\n'
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await runCapabilityFailureJourney({
    hostClient: new RuntimeClient(userDataDir, 5_000),
    offer,
    repoPath: testRepoPath,
    testInfo,
    topology: 'headed'
  })
})

test('keeps browser failure cleanup on a headless host', async ({ testRepoPath }, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    '<!doctype html><html><body><h1>headless capability fault</h1></body></html>\n'
  )
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Browser failure cleanup canary'
    })
    await runReconciliationFailureJourney({
      hostClient: host.client,
      offer: host.offer,
      repoPath: testRepoPath,
      testInfo,
      topology: 'headless'
    })
    await runCapabilityFailureJourney({
      hostClient: host.client,
      offer: host.offer,
      repoPath: testRepoPath,
      testInfo,
      topology: 'headless'
    })
  } finally {
    await host.dispose()
  }
})
