import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { SkillInstallDestination } from '../../src/shared/skill-install-contract'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  REMOTE_SKILL_CLOUD_ORIGIN,
  REMOTE_SKILL_NAME,
  REMOTE_SKILL_PACKAGE_ID,
  REMOTE_SKILL_VERSION_ID,
  startRemoteSkillCloudFixture,
  stopRemoteSkillCloudFixture,
  type RemoteSkillCloudFixture
} from './helpers/remote-skill-cloud-fixture'

let cloud: RemoteSkillCloudFixture | null = null

test.beforeAll(async () => {
  cloud = await startRemoteSkillCloudFixture()
})

test.afterAll(async () => {
  if (cloud) {
    await stopRemoteSkillCloudFixture(cloud)
    cloud = null
  }
})

test('installs on a headed desktop runtime without a local fallback', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const fixture = requireCloudFixture()
  const requestStart = fixture.requests.length
  const folderRoot = mkdtempSync(join(tmpdir(), 'orca-paired-skill-folder-'))
  let client: PairedElectronClient | null = null
  try {
    const hostHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const worktreeId = await activeWorktreeId(orcaPage)
    const folderWorkspaceId = await createHostFolderWorkspace(orcaPage, folderRoot)
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'Skill installation client',
      { extraEnv: cloudClientEnvironment() }
    )
    await connectCloud(client.page)
    const clientHome = await client.app.evaluate(({ app }) => app.getPath('home'))

    await installPreviewRemove(client.page, client.environmentId, { scope: 'global' }, hostHome)
    await installPreviewRemove(
      client.page,
      client.environmentId,
      { scope: 'workspace', worktreeId },
      testRepoPath
    )
    await installPreviewRemove(
      client.page,
      client.environmentId,
      { scope: 'workspace', folderWorkspaceId },
      folderRoot
    )

    expect(existsSync(skillPath(clientHome))).toBe(false)
    await expectManagedInstalls(client.page, client.environmentId, [])
    expectCloudRequests(fixture, requestStart, 3)
  } finally {
    await client?.dispose()
    rmSync(skillPath(testRepoPath), { recursive: true, force: true })
    rmSync(folderRoot, { recursive: true, force: true })
  }
})

test('installs on a headless serve runtime through the same contract', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const fixture = requireCloudFixture()
  const requestStart = fixture.requests.length
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(host.offer, testInfo, 'Headless skill client', {
      extraEnv: cloudClientEnvironment()
    })
    await connectCloud(client.page)
    const hostHome = await host.app.evaluate(({ app }) => app.getPath('home'))
    const clientHome = await client.app.evaluate(({ app }) => app.getPath('home'))
    const worktreeId = await addHeadlessHostWorktree(host, testRepoPath)

    await installPreviewRemove(client.page, client.environmentId, { scope: 'global' }, hostHome)
    await installPreviewRemove(
      client.page,
      client.environmentId,
      { scope: 'workspace', worktreeId },
      testRepoPath
    )

    expect(existsSync(skillPath(clientHome))).toBe(false)
    await expectManagedInstalls(client.page, client.environmentId, [])
    expectCloudRequests(fixture, requestStart, 2)
  } finally {
    await client?.dispose()
    await host.dispose()
    rmSync(skillPath(testRepoPath), { recursive: true, force: true })
  }
})

function cloudClientEnvironment(): Record<string, string> {
  return {
    ORCA_ARTIFACTS_API_URL: REMOTE_SKILL_CLOUD_ORIGIN,
    ORCA_CLOUD_API_URL: REMOTE_SKILL_CLOUD_ORIGIN,
    ORCA_CLOUD_CLIENT_ID: 'skills-e2e-client',
    ORCA_CLOUD_DEV_AUTH: '1',
    ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
    ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS: REMOTE_SKILL_CLOUD_ORIGIN
  }
}

async function connectCloud(page: Page): Promise<void> {
  const auth = await page.evaluate(() => window.api.orcaProfiles.connectCurrent())
  expect(auth.status).toBe('connected')
}

function requireCloudFixture(): RemoteSkillCloudFixture {
  if (!cloud) {
    throw new Error('skill Cloud fixture unavailable')
  }
  return cloud
}

function skillPath(root: string): string {
  return join(root, '.agents', 'skills', REMOTE_SKILL_NAME)
}

async function activeWorktreeId(page: Page): Promise<string> {
  const worktreeId = await page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null)
  if (!worktreeId) {
    throw new Error('headed host worktree unavailable')
  }
  return worktreeId
}

async function createHostFolderWorkspace(page: Page, folderPath: string): Promise<string> {
  return page.evaluate(async (path) => {
    const group = await window.api.projectGroups.create({
      name: 'Paired skill folder E2E',
      parentPath: path
    })
    const workspace = await window.api.folderWorkspaces.create({
      projectGroupId: group.id,
      name: 'Paired skill folder E2E',
      folderPath: path
    })
    return workspace.id
  }, folderPath)
}

async function addHeadlessHostWorktree(
  host: HeadlessPairedRuntimeHost,
  repoPath: string
): Promise<string> {
  const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
    path: repoPath,
    kind: 'git'
  })
  let worktreeId = ''
  await expect
    .poll(async () => {
      const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
        repo: `id:${added.result.repo.id}`
      })
      worktreeId = listed.result.worktrees[0]?.id ?? ''
      return worktreeId
    })
    .not.toBe('')
  return worktreeId
}

async function installPreviewRemove(
  page: Page,
  environmentId: string,
  destination: SkillInstallDestination,
  root: string
): Promise<void> {
  const operation = await page.evaluate(
    ({ destination, environmentId, packageId, versionId }) =>
      window.api.skills.installPackageVersion({
        packageId,
        versionId,
        environmentId,
        destination
      }),
    {
      destination,
      environmentId,
      packageId: REMOTE_SKILL_PACKAGE_ID,
      versionId: REMOTE_SKILL_VERSION_ID
    }
  )
  expect(operation, JSON.stringify(operation, null, 2)).toMatchObject({
    status: 'ok',
    value: { status: 'installed', name: REMOTE_SKILL_NAME }
  })
  expect(readFileSync(join(skillPath(root), 'SKILL.md'), 'utf8')).toContain('# Remote E2E')

  const fixture = requireCloudFixture()
  const preview = await page.evaluate(
    ({ destination, environmentId, name, packageIdentity }) =>
      window.api.skills.previewInstall({
        environmentId,
        package: packageIdentity,
        name,
        destination
      }),
    {
      destination,
      environmentId,
      name: REMOTE_SKILL_NAME,
      packageIdentity: {
        packageId: fixture.archive.manifest.packageId,
        versionId: fixture.archive.manifest.versionId,
        packageDigest: fixture.archive.manifest.packageDigest,
        archiveSha256: fixture.archive.archiveSha256,
        compressedBytes: fixture.bytes.length
      }
    }
  )
  expect(preview).toMatchObject({ status: 'ok', value: { currentState: 'unchanged' } })

  const removed = await page.evaluate(
    ({ destination, environmentId, name }) =>
      window.api.skills.removeInstall({ environmentId, name, destination }),
    { destination, environmentId, name: REMOTE_SKILL_NAME }
  )
  expect(removed).toMatchObject({ status: 'ok', value: { status: 'removed' } })
  expect(existsSync(skillPath(root))).toBe(false)
}

async function expectManagedInstalls(
  page: Page,
  environmentId: string,
  expected: unknown[]
): Promise<void> {
  const installs = await page.evaluate(
    (id) => window.api.skills.listManagedInstalls(id),
    environmentId
  )
  expect(installs).toMatchObject({ status: 'ok', value: expected })
}

function expectCloudRequests(
  fixture: RemoteSkillCloudFixture,
  start: number,
  expectedInstalls: number
): void {
  const requests = fixture.requests.slice(start)
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(expectedInstalls)
  expect(requests.filter((request) => request.path === '/package.tar.gz')).toHaveLength(
    expectedInstalls
  )
  expect(
    requests.filter((request) => request.method === 'POST').map((request) => request.body)
  ).toEqual(Array.from({ length: expectedInstalls }, () => ({ installTarget: 'remote' })))
}
