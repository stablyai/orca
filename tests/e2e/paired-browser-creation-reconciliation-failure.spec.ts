import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { expect, test } from './helpers/orca-app'
import { readHostBrowserPageIds, readHostTabs } from './helpers/host-session-tabs'
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

// Drives the real create menu so the failure surfaces through handleNewBrowserTab's toast.
async function startBrowserCreate(page: Page): Promise<void> {
  await page.evaluate(() => window.__store?.getState().setBrowserDefaultUrl('about:blank'))
  await page.getByRole('button', { name: 'New tab' }).first().click()
  const newBrowserTab = page.getByRole('menuitem', { name: /New Browser Tab/i })
  await expect(newBrowserTab).toBeVisible({ timeout: 30_000 })
  await newBrowserTab.click()
}

async function readStableHostTabs(hostClient: RuntimeClient, repoPath: string) {
  const { publicationEpoch, snapshotVersion, ...state } = await readHostTabs(hostClient, repoPath)
  expect(publicationEpoch).not.toBe('')
  expect(snapshotVersion).toBeGreaterThan(0)
  return state
}

type ClientTabState = {
  browserTabIds: string[]
  browserWorkspaceIds: string[]
  editorTabIds: string[]
  groupIds: string[]
  terminalTabIds: string[]
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

    const baselineClient = await readClientTabs(page, worktreeId)
    expect(baselineClient.terminalTabIds).not.toHaveLength(0)
    const baselineHostBrowserIds = await readHostBrowserPageIds(args.hostClient, args.repoPath)

    await page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser reconciliation E2E fault seam unavailable')
      }
      fault.arm()
    })
    await startBrowserCreate(page)

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

    expect(await readHostBrowserPageIds(args.hostClient, args.repoPath)).toContain(createdPageId)
    // The managed-browser action stages one tab in the active group while the host create is held.
    // The rollback assertions prove that optimism is unwound rather than stranded.
    const heldClient = await readClientTabs(page, worktreeId)
    const addedSince = (baseline: string[], held: string[]): string[] => {
      expect(held).toEqual(expect.arrayContaining(baseline))
      return held.filter((id) => !baseline.includes(id))
    }
    expect(addedSince(baselineClient.browserTabIds, heldClient.browserTabIds)).toHaveLength(1)
    expect(
      addedSince(baselineClient.browserWorkspaceIds, heldClient.browserWorkspaceIds)
    ).toHaveLength(1)
    expect(heldClient.editorTabIds).toEqual(baselineClient.editorTabIds)
    expect(heldClient.terminalTabIds).toEqual(baselineClient.terminalTabIds)
    expect(heldClient.groupIds).toEqual(baselineClient.groupIds)

    await page.screenshot({
      path: args.testInfo.outputPath(`${args.topology}-browser-reconciliation-held.png`),
      fullPage: true
    })
    expect(
      await page.evaluate(
        () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.release() ?? false
      )
    ).toBe(true)

    await expect(
      page.getByText('The paired runtime could not create a managed browser tab.')
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => readHostBrowserPageIds(args.hostClient, args.repoPath), {
        timeout: 30_000,
        message: 'rollback did not close the exact host browser page'
      })
      .not.toContain(createdPageId)
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
    expect(await readHostBrowserPageIds(args.hostClient, args.repoPath)).toEqual(
      baselineHostBrowserIds
    )
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

    const baselineClient = await readClientTabs(page, worktreeId)
    const baselineHost = await readStableHostTabs(args.hostClient, args.repoPath)

    await page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser capability E2E fault seam unavailable')
      }
      fault.armCapabilityRejection()
    })
    await startBrowserCreate(page)

    await expect(page.getByText(/E2E forced browser capability rejection/)).toBeVisible({
      timeout: 30_000
    })
    // Why: baseline equality alone also holds for a create that was rolled back. A null page id is
    // what separates rejecting before the host create from undoing one afterwards.
    expect(
      await page.evaluate(
        () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
      )
    ).toMatchObject({ createdPageId: null })
    await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 30_000,
        message: 'client split state did not settle after capability rejection'
      })
      .toEqual(baselineClient)
    expect(await readStableHostTabs(args.hostClient, args.repoPath)).toEqual(baselineHost)
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
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await runReconciliationFailureJourney({
    // Why 30s: browser.tabList on a headed host with no live browser tab first activates the
    // browser view and waits up to 8s for a webview registration before answering; a 5s client
    // times out before the runtime ever replies.
    hostClient: new RuntimeClient(userDataDir, 30_000),
    offer,
    repoPath: testRepoPath,
    testInfo,
    topology: 'headed'
  })
})

test('cleans up a headed-host browser when capability rejects before create @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await runCapabilityFailureJourney({
    // Why 30s: browser.tabList on a headed host with no live browser tab first activates the
    // browser view and waits up to 8s for a webview registration before answering; a 5s client
    // times out before the runtime ever replies.
    hostClient: new RuntimeClient(userDataDir, 30_000),
    offer,
    repoPath: testRepoPath,
    testInfo,
    topology: 'headed'
  })
})

test('keeps browser failure cleanup on a headless host', async ({ testRepoPath }, testInfo) => {
  test.setTimeout(300_000)
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
