import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import type { OrcadActivationRecord } from '../../src/main/ssh/orcad-activation-record'
import {
  createOrcadActivationTransaction,
  serializeOrcadActivationTransaction
} from '../../src/main/ssh/orcad-activation-transaction'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'

const RUN_LIFECYCLE = process.env.ORCA_REVIEW_ORCAD_SSH_UI_LIFECYCLE === '1'
const SERVER_NAME = 'Disposable managed Orca server'
const ACTIVATION_LOCK_PATH = '/root/.orca-remote/.orcad-activation-transaction/.install-lock'
const ACTIVATION_TRANSACTION_PATH =
  '/root/.orca-remote/.orcad-activation-transaction/transaction.json'
const DECOMMISSION_PAUSED_PATH = '/tmp/orca-managed-decommission-paused'
const DECOMMISSION_MONITOR_LOG_PATH = '/tmp/orca-managed-decommission-monitor.log'
const STATIC_FOLDER_PATH = '/root/orca-managed-static-folder'
const STATIC_REPOSITORY_NAME = 'Direct SSH migration repository'
const STATIC_PARENT_GROUP_NAME = 'Direct SSH migration parent'
const STATIC_CHILD_GROUP_NAME = 'Direct SSH migration child'
const STATIC_FOLDER_WORKSPACE_NAME = 'Direct SSH migration folder'
const TemplateManifestSchema = z.object({
  schemaVersion: z.literal(2),
  commonSha256: z.record(z.string(), z.string()),
  targets: z.record(z.string(), z.unknown())
})

test.skip(!RUN_LIFECYCLE, 'Run with ORCA_REVIEW_ORCAD_SSH_UI_LIFECYCLE=1')
test.use({ seedTestRepo: false })

type RpcResponse<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; error: { message: string } }

type SeededStaticCatalog = {
  targetId: string
  repository: { id: string; path: string; displayName: string; projectGroupId?: string | null }
  parentGroup: { id: string; name: string; parentGroupId: string | null }
  childGroup: { id: string; name: string; parentGroupId: string | null }
  folderWorkspace: { id: string; name: string; folderPath: string; projectGroupId: string }
}

async function rpc<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await page.evaluate(
    ({ environmentId, method, params }) =>
      window.api.runtimeEnvironments.call({ selector: environmentId, method, params }),
    { environmentId, method, params }
  )
  const typed = response as RpcResponse<TResult>
  if (!typed.ok) {
    throw new Error(`${method} failed: ${typed.error.message}`)
  }
  return typed.result
}

function serverRow(section: Locator): Locator {
  return section
    .getByText(SERVER_NAME, { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"items-start")][1]')
}

async function openManagedServers(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    state.openSettingsTarget({ pane: 'servers', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  const section = page.locator('[data-settings-section="managed-orcad-servers"]')
  await expect(section).toBeVisible({ timeout: 10_000 })
  return section
}

async function seedSshTarget(
  page: Page,
  target: DockerSshRelayTarget
): Promise<SeededStaticCatalog> {
  execDockerSshRelayTargetCommand(target, `mkdir -p ${shellQuote(STATIC_FOLDER_PATH)}`)
  return page.evaluate(
    async ({ folderPath, label, names, repoPath, target }) => {
      window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      const result = await window.api.ssh.addTarget({
        target: {
          label,
          host: target.host,
          port: target.port,
          username: 'root',
          identityFile: target.identityFile,
          identitiesOnly: true
        }
      })
      window.__store?.getState().recordSshRepoReadoptions(result.repoReadoptions)
      try {
        const connected = await window.api.ssh.connect({ targetId: result.target.id })
        if (connected?.status !== 'connected') {
          throw new Error(`Direct SSH seed did not connect: ${JSON.stringify(connected)}`)
        }
        const added = await window.api.repos.addRemote({
          connectionId: result.target.id,
          remotePath: repoPath,
          displayName: names.repository
        })
        if ('error' in added) {
          throw new Error(added.error)
        }
        const parentGroup = await window.api.projectGroups.create({
          name: names.parentGroup,
          parentPath: '/root',
          connectionId: result.target.id
        })
        const childGroup = await window.api.projectGroups.create({
          name: names.childGroup,
          parentPath: '/root',
          connectionId: result.target.id,
          parentGroupId: parentGroup.id
        })
        const repository = await window.api.projectGroups.moveProject({
          projectId: added.repo.id,
          groupId: childGroup.id
        })
        if (!repository) {
          throw new Error('Direct SSH repository disappeared while assigning its project group')
        }
        const folderWorkspace = await window.api.folderWorkspaces.create({
          projectGroupId: childGroup.id,
          name: names.folderWorkspace,
          folderPath,
          connectionId: result.target.id
        })
        return {
          targetId: result.target.id,
          repository,
          parentGroup,
          childGroup,
          folderWorkspace
        }
      } finally {
        // The migration boundary requires a host-acknowledged drain, even when this seed created no PTYs.
        await window.api.ssh.terminateSessions({ targetId: result.target.id })
      }
    },
    {
      folderPath: STATIC_FOLDER_PATH,
      label: SERVER_NAME,
      names: {
        repository: STATIC_REPOSITORY_NAME,
        parentGroup: STATIC_PARENT_GROUP_NAME,
        childGroup: STATIC_CHILD_GROUP_NAME,
        folderWorkspace: STATIC_FOLDER_WORKSPACE_NAME
      },
      repoPath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
      target
    }
  )
}

async function deployThroughSettings(
  section: Locator,
  page: Page,
  testInfo: TestInfo,
  catalog: SeededStaticCatalog
): Promise<void> {
  await section.getByRole('button', { name: 'Deploy Server' }).click()
  const form = section.locator('form')
  await form.locator('#managed-orcad-name').fill(SERVER_NAME)
  await form.getByRole('combobox', { name: 'SSH host' }).click()
  await page.getByRole('option', { name: SERVER_NAME }).click()
  await expect(form).toContainText('This direct SSH catalog will move to the managed server:')
  await expect(form).toContainText(`1 repository${catalog.repository.displayName}`)
  await expect(form).toContainText(`1 folder workspace${catalog.folderWorkspace.name}`)
  await testInfo.attach('managed-orcad-static-migration-preflight.png', {
    body: await page.screenshot(),
    contentType: 'image/png'
  })
  await form.getByRole('button', { name: 'Deploy', exact: true }).click()
  try {
    await expect(serverRow(section)).toBeVisible({ timeout: 180_000 })
  } catch (error) {
    const failureState = await page.evaluate(
      async (targetId) =>
        Promise.all([
          window.api.runtimeEnvironments.preflightOrcadTarget({ sshTargetId: targetId }),
          window.api.ui.get(),
          window.api.session.get()
        ]).then(([preflight, ui, session]) => ({ preflight, ui, session })),
      catalog.targetId
    )
    await testInfo.attach('managed-orcad-static-migration-failure-state.json', {
      body: Buffer.from(JSON.stringify(failureState, null, 2)),
      contentType: 'application/json'
    })
    throw error
  }
}

async function assertStaticCatalogMigrated(
  page: Page,
  environmentId: string,
  catalog: SeededStaticCatalog
): Promise<void> {
  const [repositories, groups, folderWorkspaces] = await Promise.all([
    rpc<{ repos: SeededStaticCatalog['repository'][] }>(
      page,
      environmentId,
      'repo.list',
      undefined
    ),
    rpc<{ groups: SeededStaticCatalog['parentGroup'][] }>(
      page,
      environmentId,
      'projectGroup.list',
      undefined
    ),
    rpc<{ folderWorkspaces: SeededStaticCatalog['folderWorkspace'][] }>(
      page,
      environmentId,
      'folderWorkspace.list',
      undefined
    )
  ])
  const migratedRepository = repositories.repos.find(
    (repository) => repository.id === catalog.repository.id
  )
  expect(migratedRepository).toMatchObject({
    id: catalog.repository.id,
    path: catalog.repository.path,
    displayName: catalog.repository.displayName,
    projectGroupId: catalog.childGroup.id
  })
  expect(migratedRepository).not.toHaveProperty('connectionId')
  expect(groups.groups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...catalog.parentGroup, connectionId: null }),
      expect.objectContaining({ ...catalog.childGroup, connectionId: null })
    ])
  )
  expect(folderWorkspaces.folderWorkspaces).toContainEqual(
    expect.objectContaining({ ...catalog.folderWorkspace, connectionId: null })
  )

  const sourceRows = await page.evaluate(
    async ({ folderWorkspaceId, groupIds, repositoryId, targetId }) => {
      const [sourceRepositories, sourceGroups, sourceFolderWorkspaces, targets] = await Promise.all(
        [
          window.api.repos.list(),
          window.api.projectGroups.list(),
          window.api.folderWorkspaces.list(),
          window.api.ssh.listTargets()
        ]
      )
      return {
        repositoryPresent: sourceRepositories.some(
          (repo) => repo.id === repositoryId && repo.connectionId === targetId
        ),
        groupIdsPresent: sourceGroups
          .filter((group) => groupIds.includes(group.id) && group.connectionId === targetId)
          .map((group) => group.id),
        folderWorkspacePresent: sourceFolderWorkspaces.some(
          (workspace) => workspace.id === folderWorkspaceId && workspace.connectionId === targetId
        ),
        targetVisibleAsDirectSsh: targets.some((target) => target.id === targetId)
      }
    },
    {
      folderWorkspaceId: catalog.folderWorkspace.id,
      groupIds: [catalog.parentGroup.id, catalog.childGroup.id],
      repositoryId: catalog.repository.id,
      targetId: catalog.targetId
    }
  )
  expect(sourceRows).toEqual({
    repositoryPresent: false,
    groupIdsPresent: [],
    folderWorkspacePresent: false,
    targetVisibleAsDirectSsh: false
  })
}

async function assertDurableStaticMigrationReceipt(
  electronApp: ElectronApplication,
  catalog: SeededStaticCatalog
): Promise<void> {
  const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const profileIndex = JSON.parse(
    readFileSync(join(userDataPath, 'orca-profile-index.json'), 'utf8')
  ) as { activeProfileId: string }
  const persisted = JSON.parse(
    readFileSync(
      join(userDataPath, 'profiles', profileIndex.activeProfileId, 'orca-data.json'),
      'utf8'
    )
  ) as {
    orcadMigrationSourceCutovers?: {
      phase: string
      destinationEnvironmentId: string
      receipt?: {
        repositoryIds: string[]
        projectGroupIds: string[]
        folderWorkspaceIds: string[]
      }
    }[]
  }
  expect(persisted.orcadMigrationSourceCutovers).toContainEqual(
    expect.objectContaining({
      phase: 'source-retired',
      receipt: expect.objectContaining({
        repositoryIds: [catalog.repository.id],
        projectGroupIds: [catalog.parentGroup.id, catalog.childGroup.id],
        folderWorkspaceIds: [catalog.folderWorkspace.id]
      })
    })
  )
}

async function managedEnvironmentId(page: Page): Promise<string> {
  return expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          const environments = await window.api.runtimeEnvironments.list()
          return environments.find(
            (environment) => environment.name === name && environment.orcadDeployment
          )?.id
        }, SERVER_NAME),
      { timeout: 30_000 }
    )
    .not.toBeUndefined()
    .then(async () =>
      page.evaluate(async (name) => {
        const environments = await window.api.runtimeEnvironments.list()
        const environment = environments.find(
          (candidate) => candidate.name === name && candidate.orcadDeployment
        )
        if (!environment) {
          throw new Error('Managed environment was not persisted')
        }
        return environment.id
      }, SERVER_NAME)
    )
}

async function status(page: Page, environmentId: string) {
  return page.evaluate(
    (selector) => window.api.runtimeEnvironments.getOrcadStatus({ selector }),
    environmentId
  )
}

async function createMarkedTerminal(
  page: Page,
  environmentId: string
): Promise<{ handle: string; marker: string }> {
  const repo = await rpc<{ repo: { id: string } }>(page, environmentId, 'repo.add', {
    path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
  })
  const worktrees = await rpc<{ worktrees: { id: string; path: string }[] }>(
    page,
    environmentId,
    'worktree.list',
    { repo: `id:${repo.repo.id}`, limit: 100 }
  )
  const worktree = worktrees.worktrees.find(
    (candidate) => candidate.path === DOCKER_SSH_RELAY_REMOTE_REPO_PATH
  )
  if (!worktree) {
    throw new Error('Seeded remote worktree was not listed')
  }
  const terminal = await rpc<{ terminal: { handle: string } }>(
    page,
    environmentId,
    'terminal.create',
    { worktree: worktree.id }
  )
  const marker = `ORCAD_SSH_UI_${randomBytes(8).toString('hex')}`
  await rpc(page, environmentId, 'terminal.send', {
    terminal: terminal.terminal.handle,
    text: `echo ${marker}`,
    enter: true
  })
  await waitForMarker(page, environmentId, terminal.terminal.handle, marker)
  return { handle: terminal.terminal.handle, marker }
}

async function waitForMarker(
  page: Page,
  environmentId: string,
  handle: string,
  marker: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await rpc<{ terminal: { tail: string[] } }>(
          page,
          environmentId,
          'terminal.read',
          { terminal: handle, limit: 1_000 }
        )
        return result.terminal.tail.some((line) => line.trim() === marker)
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function daemonPid(page: Page, environmentId: string): Promise<number> {
  const health = await rpc<{ terminalDaemon?: { pid?: number } }>(
    page,
    environmentId,
    'orcad.health',
    {}
  )
  const pid = health.terminalDaemon?.pid
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
    throw new Error(`orcad.health returned an invalid daemon PID: ${JSON.stringify(health)}`)
  }
  return pid
}

function mutateTemplate(templateDir: string): void {
  const orcadPath = join(templateDir, 'orcad.js')
  appendFileSync(orcadPath, '\n// disposable rendered SSH lifecycle candidate\n')
  const manifestPath = join(templateDir, 'orcad-template.json')
  const manifest = TemplateManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  manifest.commonSha256['orcad.js'] = createHash('sha256')
    .update(readFileSync(orcadPath))
    .digest('hex')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function armRemoteDecommissionPause(target: DockerSshRelayTarget, version: string): void {
  const pidPath = `/root/.orca-remote/orcad-${version}/.orcad-pid`
  const monitor = [
    'set -eu',
    `while [ ! -d ${shellQuote(ACTIVATION_LOCK_PATH)} ]; do sleep 0.01; done`,
    `pid=$(cat ${shellQuote(pidPath)})`,
    'kill -STOP "$pid"',
    `printf '%s\\n' "$pid" > ${shellQuote(DECOMMISSION_PAUSED_PATH)}`
  ].join('; ')
  execDockerSshRelayTargetCommand(
    target,
    [
      `rm -f ${shellQuote(DECOMMISSION_PAUSED_PATH)} ${shellQuote(DECOMMISSION_MONITOR_LOG_PATH)}`,
      `nohup bash --noprofile --norc -c ${shellQuote(monitor)} > ${shellQuote(DECOMMISSION_MONITOR_LOG_PATH)} 2>&1 </dev/null &`
    ].join('; ')
  )
}

async function waitForRemoteDecommissionPause(target: DockerSshRelayTarget): Promise<number> {
  let pausedPid = ''
  await expect
    .poll(
      () => {
        pausedPid = execDockerSshRelayTargetCommand(
          target,
          `cat ${shellQuote(DECOMMISSION_PAUSED_PATH)} 2>/dev/null || true`
        )
        return pausedPid
      },
      { timeout: 30_000 }
    )
    .toMatch(/^\d+$/)
  return Number(pausedPid)
}

function resumeRemoteOrcad(target: DockerSshRelayTarget, pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid paused orcad PID: ${pid}`)
  }
  execDockerSshRelayTargetCommand(target, `kill -CONT ${pid}`)
}

function injectPreparedActivationRecovery(
  target: DockerSshRelayTarget,
  candidateVersion: string,
  record: OrcadActivationRecord
): void {
  if (!record.active) {
    throw new Error('Cannot inject activation recovery without an active version')
  }
  const now = new Date()
  const transaction = createOrcadActivationTransaction({
    transactionId: randomUUID(),
    candidateVersion,
    recordBefore: record,
    snapshotDirName: `pre-${candidateVersion}-${now.getTime()}`,
    now
  })
  const root = ACTIVATION_TRANSACTION_PATH.slice(0, ACTIVATION_TRANSACTION_PATH.lastIndexOf('/'))
  execDockerSshRelayTargetCommand(
    target,
    [
      `mkdir -p ${shellQuote(ACTIVATION_LOCK_PATH)}`,
      `printf %s ${shellQuote(serializeOrcadActivationTransaction(transaction))} > ${shellQuote(ACTIVATION_TRANSACTION_PATH)}`,
      `touch -d '25 minutes ago' ${shellQuote(ACTIVATION_LOCK_PATH)}`,
      `test -d ${shellQuote(root)}`
    ].join('; ')
  )
}

async function setActiveEnvironment(page: Page, environmentId: string | null): Promise<void> {
  await page.evaluate(async (activeRuntimeEnvironmentId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const settings = await window.api.settings.setActiveRuntimeEnvironmentPreference({
      environmentId: activeRuntimeEnvironmentId
    })
    store.setState({ settings })
  }, environmentId)
}

test('renders lossless managed update, rollback, and guarded unlink over real SSH', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(720_000)
  const templateDir = process.env.ORCA_ORCAD_TEMPLATE_PATH
  if (!templateDir) {
    throw new Error('ORCA_ORCAD_TEMPLATE_PATH is required')
  }
  let target: DockerSshRelayTarget | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    const staticCatalog = await seedSshTarget(orcaPage, target)
    let section = await openManagedServers(orcaPage)
    await deployThroughSettings(section, orcaPage, testInfo, staticCatalog)

    const environmentId = await managedEnvironmentId(orcaPage)
    await assertStaticCatalogMigrated(orcaPage, environmentId, staticCatalog)
    await assertDurableStaticMigrationReceipt(electronApp, staticCatalog)
    await testInfo.attach('managed-orcad-static-migration-committed.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    const initialStatus = await status(orcaPage, environmentId)
    if (!initialStatus.activeVersion) {
      throw new Error('Initial deployment has no active version')
    }
    await expect(serverRow(section)).toContainText(initialStatus.activeVersion)
    const terminal = await createMarkedTerminal(orcaPage, environmentId)
    const initialDaemonPid = await daemonPid(orcaPage, environmentId)

    mutateTemplate(templateDir)
    await serverRow(section).getByRole('button', { name: 'Update' }).click()
    const forceDialog = orcaPage.getByRole('dialog', { name: 'Force orcad update?' })
    await expect(forceDialog).toBeVisible({ timeout: 180_000 })
    await expect(forceDialog).toContainText('terminal')
    const candidateVersion = (await forceDialog.locator('.font-mono').textContent())?.trim()
    if (!candidateVersion) {
      throw new Error('Force dialog omitted the candidate version')
    }
    await forceDialog.getByRole('button', { name: 'Force Update' }).click()
    await expect(forceDialog).toBeHidden({ timeout: 180_000 })
    await expect
      .poll(() => status(orcaPage, environmentId), { timeout: 180_000 })
      .toMatchObject({
        activeVersion: candidateVersion,
        previousVersion: initialStatus.activeVersion,
        rollbackAvailable: true
      })
    await expect(serverRow(section)).toContainText(candidateVersion)
    await waitForMarker(orcaPage, environmentId, terminal.handle, terminal.marker)
    expect(await daemonPid(orcaPage, environmentId)).toBe(initialDaemonPid)

    await serverRow(section).getByRole('button', { name: 'Rollback' }).click()
    const rollbackDialog = orcaPage.getByRole('dialog', {
      name: `Roll back ${SERVER_NAME}?`
    })
    await expect(rollbackDialog).toContainText(initialStatus.activeVersion)
    await rollbackDialog.getByRole('button', { name: 'Roll Back' }).click()
    await expect(rollbackDialog).toBeHidden({ timeout: 180_000 })
    await expect
      .poll(() => status(orcaPage, environmentId), { timeout: 180_000 })
      .toMatchObject({ activeVersion: initialStatus.activeVersion })
    await waitForMarker(orcaPage, environmentId, terminal.handle, terminal.marker)
    expect(await daemonPid(orcaPage, environmentId)).toBe(initialDaemonPid)

    const rollbackStatus = await status(orcaPage, environmentId)
    injectPreparedActivationRecovery(target, candidateVersion, {
      schemaVersion: 1,
      active: rollbackStatus.activeVersion,
      previous: rollbackStatus.previousVersion,
      activatedAt: rollbackStatus.activatedAt,
      snapshot: null,
      decommissioning: null
    })
    await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
    await expect(section).toBeHidden()
    section = await openManagedServers(orcaPage)
    const interruptedRow = serverRow(section)
    await expect(interruptedRow).toContainText(
      `Activation of ${candidateVersion} was interrupted at preparation`,
      { timeout: 30_000 }
    )
    await expect(interruptedRow.getByRole('button', { name: 'Recover' })).toBeVisible()
    await testInfo.attach('managed-orcad-recovery-required.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    const recoveryPageErrors: string[] = []
    const recordRecoveryPageError = (error: Error): void => {
      recoveryPageErrors.push(error.message)
    }
    orcaPage.on('pageerror', recordRecoveryPageError)
    await interruptedRow.getByRole('button', { name: 'Recover' }).click()
    await expect
      .poll(() => status(orcaPage, environmentId), { timeout: 30_000 })
      .toMatchObject({ recovery: null, activeVersion: initialStatus.activeVersion })
    await expect(interruptedRow).not.toContainText('was interrupted')
    orcaPage.off('pageerror', recordRecoveryPageError)
    expect(recoveryPageErrors).toEqual([])

    await serverRow(section)
      .getByRole('button', { name: `Stop and unlink ${SERVER_NAME}` })
      .click()
    let stopDialog = orcaPage.getByRole('dialog', { name: `Stop and unlink ${SERVER_NAME}?` })
    await expect(stopDialog).toBeVisible()
    await stopDialog.getByRole('button', { name: 'Stop and Unlink' }).click()
    await expect(stopDialog).toBeHidden({ timeout: 30_000 })
    await expect(serverRow(section)).toContainText('1 terminal session is still live', {
      timeout: 30_000
    })
    await expect(serverRow(section).getByRole('button', { name: 'Cancel Stop' })).toBeEnabled()
    await testInfo.attach('managed-orcad-live-refusal.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })

    execDockerSshRelayTargetCommand(
      target,
      `touch -d '25 minutes ago' ${shellQuote(ACTIVATION_LOCK_PATH)}`
    )
    await serverRow(section).getByRole('button', { name: 'Cancel Stop' }).click()
    await expect(serverRow(section).getByRole('button', { name: 'Cancel Stop' })).toBeHidden({
      timeout: 30_000
    })
    await expect.poll(() => status(orcaPage, environmentId)).toMatchObject({ recovery: null })
    await waitForMarker(orcaPage, environmentId, terminal.handle, terminal.marker)
    const canceledStopMarker = `ORCAD_SSH_UI_${randomBytes(8).toString('hex')}`
    await rpc(orcaPage, environmentId, 'terminal.send', {
      terminal: terminal.handle,
      text: `echo ${canceledStopMarker}`,
      enter: true
    })
    await waitForMarker(orcaPage, environmentId, terminal.handle, canceledStopMarker)
    expect(await daemonPid(orcaPage, environmentId)).toBe(initialDaemonPid)

    await rpc(orcaPage, environmentId, 'terminal.close', { terminal: terminal.handle })
    armRemoteDecommissionPause(target, initialStatus.activeVersion)
    await serverRow(section)
      .getByRole('button', { name: `Stop and unlink ${SERVER_NAME}` })
      .click()
    stopDialog = orcaPage.getByRole('dialog', { name: `Stop and unlink ${SERVER_NAME}?` })
    await stopDialog.getByRole('button', { name: 'Stop and Unlink' }).click()
    const pausedOrcadPid = await waitForRemoteDecommissionPause(target)
    await setActiveEnvironment(orcaPage, environmentId)
    resumeRemoteOrcad(target, pausedOrcadPid)
    await expect(stopDialog).toBeHidden({ timeout: 30_000 })
    await expect(serverRow(section)).toContainText(
      'The host could not verify that orcad exited: Choose another Active Server in Advanced before stopping this server. The managed server remains linked.',
      { timeout: 30_000 }
    )
    await expect(serverRow(section).getByRole('button', { name: 'Cancel Stop' })).toBeEnabled()
    await expect(serverRow(section).getByRole('button', { name: 'Retry Stop' })).toBeDisabled()
    expect(await daemonPid(orcaPage, environmentId)).toBe(initialDaemonPid)
    await testInfo.attach('managed-orcad-active-stop-refusal.png', {
      body: await orcaPage.screenshot({
        path: testInfo.outputPath('managed-orcad-active-stop-refusal.png')
      }),
      contentType: 'image/png'
    })

    execDockerSshRelayTargetCommand(
      target,
      `touch -d '25 minutes ago' ${shellQuote(ACTIVATION_LOCK_PATH)}`
    )
    await serverRow(section).getByRole('button', { name: 'Cancel Stop' }).click()
    await expect(serverRow(section).getByRole('button', { name: 'Cancel Stop' })).toBeHidden({
      timeout: 30_000
    })
    await expect.poll(() => status(orcaPage, environmentId)).toMatchObject({ recovery: null })

    await setActiveEnvironment(orcaPage, null)
    await expect(
      serverRow(section).getByRole('button', { name: `Stop and unlink ${SERVER_NAME}` })
    ).toBeEnabled()
    await serverRow(section)
      .getByRole('button', { name: `Stop and unlink ${SERVER_NAME}` })
      .click()
    stopDialog = orcaPage.getByRole('dialog', { name: `Stop and unlink ${SERVER_NAME}?` })
    await stopDialog.getByRole('button', { name: 'Stop and Unlink' }).click()
    await expect(serverRow(section)).toBeHidden({ timeout: 180_000 })
    await expect(section).toContainText('No managed Orca servers.')
    await orcaPage.screenshot({ path: testInfo.outputPath('managed-orcad-unlinked.png') })
  } finally {
    cleanupDockerSshRelayTarget(target)
  }
})
