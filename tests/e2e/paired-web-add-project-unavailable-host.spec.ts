import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

type PairedWebHostIdentity = {
  environmentId: string
  hostName: string
}

type PairedWebAuthoritySnapshot = {
  environmentIds: string[]
  isPairedWeb: boolean
  mutationCalls: string[]
  pathname: string
  repos: { executionHostId: string | null; id: string; path: string }[]
}

type RepoInventory = { executionHostId: string | null; id: string; path: string }[]

const REPO_MUTATION_METHODS = [
  'add',
  'addRemote',
  'clone',
  'cloneRemote',
  'create',
  'createRemote',
  'pickDirectory',
  'pickFolder',
  'pickFolders'
] as const

const RUNTIME_MUTATION_METHODS = ['repo.add', 'repo.clone', 'repo.create'] as const
const PROJECT_GROUP_MUTATION_METHODS = ['importNested'] as const
const RUNTIME_PROJECT_GROUP_MUTATION_METHODS = ['projectGroup.importNested'] as const

function createNestedRepoFixture(): string {
  const rootPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-sta4182-nested-')))
  for (const name of ['api-service', 'web-client']) {
    const repoPath = path.join(rootPath, name)
    mkdirSync(repoPath)
    execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  }
  return rootPath
}

function normalizeRepoInventory(
  repos: { executionHostId?: string | null; id: string; path: string }[]
): RepoInventory {
  return repos
    .map((repo) => ({
      executionHostId: repo.executionHostId ?? null,
      id: repo.id,
      path: repo.path
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

async function installRepoMutationProbe(page: Page): Promise<void> {
  await page.evaluate(
    ({ projectGroupMethodNames, repoMethodNames, runtimeMethodNames }) => {
      const probeWindow = window as unknown as { __sta4182RepoMutationCalls?: string[] }
      probeWindow.__sta4182RepoMutationCalls = []
      const runtimeMutations = new Set<string>(runtimeMethodNames)
      const repos = window.api.repos as unknown as Record<
        string,
        ((...args: unknown[]) => unknown) | undefined
      >
      for (const methodName of repoMethodNames) {
        const original = repos[methodName]
        if (!original) {
          continue
        }
        repos[methodName] = (...args: unknown[]) => {
          probeWindow.__sta4182RepoMutationCalls?.push(methodName)
          return original(...args)
        }
      }
      const projectGroups = window.api.projectGroups as unknown as Record<
        string,
        ((...args: unknown[]) => unknown) | undefined
      >
      for (const methodName of projectGroupMethodNames) {
        const original = projectGroups[methodName]
        if (!original) {
          continue
        }
        projectGroups[methodName] = (...args: unknown[]) => {
          probeWindow.__sta4182RepoMutationCalls?.push(`projectGroups:${methodName}`)
          return original(...args)
        }
      }

      const runtime = window.api.runtime as unknown as Record<
        string,
        ((args: { method: string }) => unknown) | undefined
      >
      const runtimeCall = runtime.call
      if (runtimeCall) {
        runtime.call = (args: { method: string }) => {
          if (runtimeMutations.has(args.method)) {
            probeWindow.__sta4182RepoMutationCalls?.push(`runtime:${args.method}`)
          }
          return runtimeCall(args)
        }
      }
      const environments = window.api.runtimeEnvironments as unknown as Record<
        string,
        ((args: { method: string }) => unknown) | undefined
      >
      const environmentCall = environments.call
      if (environmentCall) {
        environments.call = (args: { method: string }) => {
          if (runtimeMutations.has(args.method)) {
            probeWindow.__sta4182RepoMutationCalls?.push(`runtimeEnvironment:${args.method}`)
          }
          return environmentCall(args)
        }
      }
    },
    {
      projectGroupMethodNames: [...PROJECT_GROUP_MUTATION_METHODS],
      repoMethodNames: [...REPO_MUTATION_METHODS],
      runtimeMethodNames: [...RUNTIME_MUTATION_METHODS, ...RUNTIME_PROJECT_GROUP_MUTATION_METHODS]
    }
  )
}

async function readAuthoritySnapshot(page: Page): Promise<PairedWebAuthoritySnapshot> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired web client store unavailable')
    }
    const probeWindow = window as unknown as {
      __ORCA_WEB_CLIENT__?: boolean
      __sta4182RepoMutationCalls?: string[]
    }
    const state = store.getState()
    return {
      environmentIds: state.runtimeEnvironments.map((environment) => environment.id),
      isPairedWeb: probeWindow.__ORCA_WEB_CLIENT__ === true,
      mutationCalls: [...(probeWindow.__sta4182RepoMutationCalls ?? [])],
      pathname: window.location.pathname,
      repos: state.repos
        .map((repo) => ({
          executionHostId: repo.executionHostId ?? null,
          id: repo.id,
          path: repo.path
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    }
  })
}

async function setOnlyRuntimeHostHealth(
  page: Page,
  health: HostHealth
): Promise<PairedWebHostIdentity> {
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
    store.setState({
      runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
        environment.id,
        nextHealth === 'blocked'
          ? {
              ...current,
              checkedAt: Date.now(),
              status: {
                ...current!.status!,
                protocolVersion: 0,
                runtimeProtocolVersion: 0
              }
            }
          : { ...current, checkedAt: Date.now(), status: null }
      )
    })
    return { environmentId: environment.id, hostName: environment.name }
  }, health)
}

async function recoverOnlyRuntimeHost(page: Page, environmentId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const store = window.__store
    if (!store || !(await store.getState().refreshRuntimeEnvironmentStatus(id))) {
      throw new Error('Paired web runtime did not recover')
    }
  }, environmentId)
}

async function seedPairedHostSshDecoy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired web client store unavailable')
    }
    store.getState().setSshTargetsMetadata([{ id: 'sta4182-ssh-decoy', label: 'SSH decoy' }])
    store.getState().setSshConnectionState('sta4182-ssh-decoy', {
      targetId: 'sta4182-ssh-decoy',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
  })
}

async function assertNoPairedWebSshAuthority(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /Add a project/i })
  await dialog.getByRole('combobox').click()
  await expect(page.locator('[cmdk-item][data-host-id="ssh:sta4182-ssh-decoy"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
}

async function assertCreationActionsEnabled(page: Page, environmentId: string): Promise<void> {
  await page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: /Add a project/i })
  const hostPicker = dialog.getByRole('combobox')
  await expect(hostPicker).toHaveAttribute('data-host-id', `runtime:${environmentId}`)
  await expect(hostPicker).toHaveAttribute('data-host-actionable', 'true')
  await expect(dialog.getByRole('button', { name: /Browse folder|Browse host/i })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: /Clone from URL/i })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: /Create new project/i })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Close' }).click()
}

async function assertAuthorityLossClosesMutationSteps(
  page: Page,
  environmentId: string,
  nestedFixturePath: string
): Promise<void> {
  for (const actionName of [
    /Browse folder|Browse host/i,
    /Clone from URL/i,
    /Create new project/i
  ]) {
    await page
      .getByRole('button', { name: /Add Project/i })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: /Add a project/i })
    await dialog.getByRole('button', { name: actionName }).click()
    await setOnlyRuntimeHostHealth(page, 'disconnected')
    const hostPicker = dialog.getByRole('combobox')
    await expect(hostPicker).toHaveAttribute('data-host-id', `runtime:${environmentId}`)
    await expect(hostPicker).toHaveAttribute('data-host-actionable', 'false')
    await expect(dialog.getByRole('button', { name: /Browse folder|Browse host/i })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: /Clone from URL/i })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: /Create new project/i })).toBeDisabled()
    expect((await readAuthoritySnapshot(page)).mutationCalls).toEqual([])
    await recoverOnlyRuntimeHost(page, environmentId)
    await expect(dialog.getByRole('button', { name: /Browse folder|Browse host/i })).toBeEnabled()
    await expect(dialog.getByRole('button', { name: /Clone from URL/i })).toBeEnabled()
    await expect(dialog.getByRole('button', { name: /Create new project/i })).toBeEnabled()
    await expect(dialog.getByLabel('Host path')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()
  }

  await page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = page.getByRole('dialog').last()
  await dialog.getByRole('button', { name: /Browse folder|Browse host/i }).click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.getByLabel('Host path').fill(nestedFixturePath)
  await dialog.getByRole('button', { name: 'Add Git Project' }).click()
  await expect(
    dialog.getByRole('heading', { name: /Import repositories from folder/i })
  ).toBeVisible()
  await setOnlyRuntimeHostHealth(page, 'disconnected')
  await expect(dialog.getByRole('combobox')).toHaveAttribute(
    'data-host-id',
    `runtime:${environmentId}`
  )
  await expect(dialog.getByRole('button', { name: /Browse folder|Browse host/i })).toBeDisabled()
  expect((await readAuthoritySnapshot(page)).mutationCalls).toEqual([])
  await recoverOnlyRuntimeHost(page, environmentId)
  await expect(dialog.getByRole('button', { name: /Browse folder|Browse host/i })).toBeEnabled()
  await expect(
    dialog.getByRole('heading', { name: /Import repositories from folder/i })
  ).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close' }).click()
}

async function assertCreationActionsDisabled(args: {
  health: HostHealth
  environmentId: string
  hostName: string
  page: Page
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  await args.page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = args.page.getByRole('dialog', { name: /Add a project/i })
  await expect(dialog).toBeVisible()
  const hostPicker = dialog.getByRole('combobox')
  await expect(hostPicker).toHaveAttribute('data-host-id', `runtime:${args.environmentId}`)
  await expect(hostPicker).toHaveAttribute('data-host-actionable', 'false')
  await expect(hostPicker).toContainText(args.hostName)
  await expect(hostPicker).toContainText(
    args.health === 'blocked' ? 'Update needed' : 'Disconnected'
  )
  await expect(dialog.getByRole('button', { name: /Browse folder|Browse host/i })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /Clone from URL/i })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /Create new project/i })).toBeDisabled()

  for (const button of [
    dialog.getByRole('button', { name: /Browse folder|Browse host/i }),
    dialog.getByRole('button', { name: /Clone from URL/i }),
    dialog.getByRole('button', { name: /Create new project/i })
  ]) {
    await button.evaluate((element) => (element as HTMLButtonElement).click())
  }
  expect((await readAuthoritySnapshot(args.page)).mutationCalls).toEqual([])

  await hostPicker.click()
  await expect(args.page.locator('[cmdk-item][data-host-id="local"]')).toHaveCount(0)
  const hostOption = args.page.locator(`[cmdk-item][data-host-id="runtime:${args.environmentId}"]`)
  await expect(hostOption).toHaveAttribute('aria-disabled', 'true')
  await expect(hostOption).toHaveAttribute('data-host-actionable', 'false')
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
  readHostInventory: () => Promise<RepoInventory>
  nestedFixturePath: string
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  let client: PairedWebClient | null = null
  try {
    client = await launchPairedWebClient(args.app, args.offer)
    await client.page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await installRepoMutationProbe(client.page)
    await seedPairedHostSshDecoy(client.page)
    const initialAuthority = await readAuthoritySnapshot(client.page)
    const initialHostInventory = await args.readHostInventory()
    expect(initialAuthority.pathname).toBe('/web-index.html')
    expect(initialAuthority.isPairedWeb).toBe(true)
    expect(initialAuthority.environmentIds).toHaveLength(1)
    expect(initialAuthority.mutationCalls).toEqual([])
    const environmentId = initialAuthority.environmentIds[0]!
    await client.page
      .getByRole('button', { name: /Add Project/i })
      .first()
      .click()
    await assertNoPairedWebSshAuthority(client.page)
    await client.page
      .getByRole('dialog', { name: /Add a project/i })
      .getByRole('button', { name: 'Close' })
      .click()
    await assertAuthorityLossClosesMutationSteps(client.page, environmentId, args.nestedFixturePath)
    await args.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((window) => window.show())
    })
    const { hostName } = await setOnlyRuntimeHostHealth(client.page, 'blocked')
    await assertCreationActionsDisabled({
      health: 'blocked',
      environmentId,
      hostName,
      page: client.page,
      testInfo: args.testInfo,
      topology: args.topology
    })
    expect(await setOnlyRuntimeHostHealth(client.page, 'disconnected')).toEqual({
      environmentId,
      hostName
    })
    await assertCreationActionsDisabled({
      health: 'disconnected',
      environmentId,
      hostName,
      page: client.page,
      testInfo: args.testInfo,
      topology: args.topology
    })
    await recoverOnlyRuntimeHost(client.page, environmentId)
    await assertCreationActionsEnabled(client.page, environmentId)
    expect(await readAuthoritySnapshot(client.page)).toEqual(initialAuthority)
    expect(await args.readHostInventory()).toEqual(initialHostInventory)
  } finally {
    await client?.dispose()
    rmSync(args.nestedFixturePath, { recursive: true, force: true })
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
    nestedFixturePath: createNestedRepoFixture(),
    readHostInventory: async () =>
      normalizeRepoInventory(await orcaPage.evaluate(() => window.api.repos.list())),
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
      nestedFixturePath: createNestedRepoFixture(),
      readHostInventory: async () => {
        const response = await host.client.call<{ repos: RepoInventory }>('repo.list')
        return normalizeRepoInventory(response.result.repos)
      },
      testInfo,
      topology: 'headless'
    })
  } finally {
    await host.dispose()
  }
})
