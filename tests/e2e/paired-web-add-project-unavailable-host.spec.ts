import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient,
  type PairedWebClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'

test.skip(
  process.env.ORCA_E2E_WEB_CLIENT !== '1',
  'Run with ORCA_E2E_WEB_CLIENT=1 so the paired web client is built'
)

type HostHealth = 'blocked' | 'disconnected'

async function setOnlyRuntimeHostHealth(page: Page, health: HostHealth): Promise<string> {
  return page.evaluate((nextHealth) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired web client store unavailable')
    }
    const state = store.getState()
    const environment = state.runtimeEnvironments[0]
    if (!environment) {
      throw new Error('Paired web client has no configured runtime')
    }
    const current = state.runtimeStatusByEnvironmentId.get(environment.id)
    if (nextHealth === 'blocked' && !current?.status) {
      throw new Error('Paired web runtime status unavailable for compatibility fault')
    }
    // Why rewrite the snapshot and not just the status: since #20003 the published snapshot owns
    // host health. A bare `status: null` leaves the paired-web client's verified/ready snapshot in
    // place, addRuntimeHost reads transport 'ready' before it ever looks at status, and the host
    // still renders Connected. Pinning at the top sequence also stops the live status owner
    // restoring the host mid-assertion.
    const verified = current?.status ?? current?.snapshot?.status ?? null
    const snapshot = {
      environmentId: environment.id,
      pairingRevision: environment.pairingRevision ?? environment.createdAt,
      sequence: Number.MAX_SAFE_INTEGER,
      checkedAt: Date.now(),
      ...(nextHealth === 'blocked'
        ? {
            status: { ...verified!, protocolVersion: 0, runtimeProtocolVersion: 0 },
            verification: 'verified' as const,
            transport: 'ready' as const
          }
        : {
            status: null,
            verification: 'unavailable' as const,
            // Why 'unknown' and not 'disconnected': an unavailable/unknown snapshot falls
            // through to disconnected health; explicit disconnected transport is treated as
            // reconnecting and renders Connecting.
            transport: 'unknown' as const
          })
    }
    store.setState({
      runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
        environment.id,
        {
          ...current,
          snapshot,
          checkedAt: snapshot.checkedAt,
          status: snapshot.verification === 'verified' ? snapshot.status : null,
          // Why: runtimeHealth answers 'available' on a ready remoteControl even with a null status.
          remoteControl: null
        }
      )
    })
    return environment.name
  }, health)
}

async function assertCreationActionsDisabled(args: {
  health: HostHealth
  hostName: string
  page: Page
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  await openSidebarProjectDialog(args.page)
  const dialog = args.page.getByRole('dialog', { name: /Add a project/i })
  await expect(dialog).toBeVisible()
  const hostPicker = dialog.getByRole('combobox')
  await expect(hostPicker).toContainText(args.hostName)
  await expect(hostPicker).toContainText(
    args.health === 'blocked' ? 'Update needed' : 'Disconnected'
  )
  await expect(dialog.getByRole('button', { name: /Browse folder|Browse host/i })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /Clone from URL/i })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /Create new project/i })).toBeDisabled()

  await hostPicker.click()
  const hostOption = args.page
    .locator('[cmdk-item][aria-disabled="true"]')
    .filter({ hasText: args.hostName })
  await expect(hostOption).toHaveAttribute('aria-disabled', 'true')
  await expect(hostOption).toContainText(args.health === 'blocked' ? 'Update Orca' : 'Disconnected')
  await args.page.keyboard.press('Escape')
  await args.page.screenshot({
    path: args.testInfo.outputPath(`${args.topology}-paired-web-add-project-${args.health}.png`),
    fullPage: true
  })
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
}

async function runUnavailableHostJourney(args: {
  app: ElectronApplication
  offer: RuntimeDesktopPairingOffer
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  let client: PairedWebClient | null = null
  try {
    client = await launchPairedWebClient(args.app, args.offer)
    await args.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((window) => window.show())
    })
    const hostName = await setOnlyRuntimeHostHealth(client.page, 'blocked')
    await assertCreationActionsDisabled({
      health: 'blocked',
      hostName,
      page: client.page,
      testInfo: args.testInfo,
      topology: args.topology
    })
    expect(await setOnlyRuntimeHostHealth(client.page, 'disconnected')).toBe(hostName)
    await assertCreationActionsDisabled({
      health: 'disconnected',
      hostName,
      page: client.page,
      testInfo: args.testInfo,
      topology: args.topology
    })
  } finally {
    await client?.dispose()
  }
}

test('disables paired-web Add Project for a blocked or unavailable headed host @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  await runUnavailableHostJourney({
    app: electronApp,
    offer,
    testInfo,
    topology: 'headed'
  })
})

test('keeps paired-web Add Project disabled for a headless unavailable host', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await runUnavailableHostJourney({
      app: host.app,
      offer: host.offer,
      testInfo,
      topology: 'headless'
    })
  } finally {
    await host.dispose()
  }
})
