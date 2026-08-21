import type { Page, TestInfo } from '@stablyai/playwright-test'
import type { SkillInstallDestination } from '../../src/shared/skill-install-contract'
import { test, expect } from './helpers/mcode-app'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  REMOTE_SKILL_CLOUD_ORIGIN,
  REMOTE_SKILL_NAME,
  REMOTE_SKILL_PACKAGE_ID,
  REMOTE_SKILL_VERSION_ID,
  startRemoteSkillCloudFixture,
  stopRemoteSkillCloudFixture,
  type RemoteSkillCloudFixture
} from './helpers/remote-skill-cloud-fixture'

const RUN_DOCKER_SSH = process.env.MCODE_E2E_SSH_DOCKER === '1'
const REMOTE_FOLDER = '/tmp/mcode-skill-folder-workspace'

let cloud: RemoteSkillCloudFixture | null = null

test.use({
  mcodeAppExtraEnv: {
    MCODE_ARTIFACTS_API_URL: REMOTE_SKILL_CLOUD_ORIGIN,
    MCODE_CLOUD_API_URL: REMOTE_SKILL_CLOUD_ORIGIN,
    MCODE_CLOUD_CLIENT_ID: 'skills-e2e-client',
    MCODE_CLOUD_DEV_AUTH: '1',
    MCODE_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
    MCODE_SKILL_PACKAGE_DOWNLOAD_ORIGINS: REMOTE_SKILL_CLOUD_ORIGIN
  }
})

test.beforeAll(async () => {
  cloud = await startRemoteSkillCloudFixture()
})

test.afterAll(async () => {
  if (!cloud) {
    return
  }
  await stopRemoteSkillCloudFixture(cloud)
  cloud = null
})

test.describe('SSH skill installation', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set MCODE_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH tests use POSIX ssh tooling.')

  test('installs and removes global, Git-worktree, and folder copies through the real relay', async ({
    mcodePage
  }, testInfo: TestInfo) => {
    test.slow()
    const fixture = requireCloudFixture()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      execDockerSshRelayTargetCommand(target, `mkdir -p ${REMOTE_FOLDER}`)
      await waitForSessionReady(mcodePage)
      await waitForActiveWorktree(mcodePage)
      const remote = await connectDockerSshRelayTarget(mcodePage, target)
      const auth = await mcodePage.evaluate(() => window.api.mcodeProfiles.connectCurrent())
      expect(auth.status).toBe('connected')

      const globalDestination: SkillInstallDestination = {
        scope: 'global',
        executionTarget: { kind: 'ssh', connectionId: remote.targetId }
      }
      await installAndVerify(
        mcodePage,
        target,
        globalDestination,
        '/root/.agents/skills/remote-e2e-skill'
      )
      const globalInstalls = await mcodePage.evaluate(
        (environmentId) => window.api.skills.listManagedInstalls(environmentId),
        `ssh:${remote.targetId}`
      )
      expect(globalInstalls).toMatchObject({
        status: 'ok',
        value: [
          {
            name: REMOTE_SKILL_NAME,
            destination: {
              scope: 'global',
              executionTarget: { kind: 'ssh', connectionId: remote.targetId }
            }
          }
        ]
      })
      await previewUnchanged(mcodePage, globalDestination)
      await removeAndVerify(
        mcodePage,
        target,
        globalDestination,
        '/root/.agents/skills/remote-e2e-skill'
      )

      const worktreeDestination: SkillInstallDestination = {
        scope: 'workspace',
        worktreeId: remote.worktreeId
      }
      const worktreePath = '/tmp/mcode-docker-relay-perf-repo/.agents/skills/remote-e2e-skill'
      await installAndVerify(mcodePage, target, worktreeDestination, worktreePath)
      await removeAndVerify(mcodePage, target, worktreeDestination, worktreePath)

      const folderWorkspaceId = await createRemoteFolderWorkspace(mcodePage, remote.targetId)
      const folderDestination: SkillInstallDestination = {
        scope: 'workspace',
        folderWorkspaceId
      }
      const folderPath = `${REMOTE_FOLDER}/.agents/skills/remote-e2e-skill`
      await installAndVerify(mcodePage, target, folderDestination, folderPath)
      await removeAndVerify(mcodePage, target, folderDestination, folderPath)

      expect(fixture.requests.filter((request) => request.method === 'POST')).toHaveLength(3)
      expect(fixture.requests.filter((request) => request.path === '/package.tar.gz')).toHaveLength(
        3
      )
      expect(
        fixture.requests
          .filter((request) => request.method === 'POST')
          .map((request) => request.body)
      ).toEqual([
        { installTarget: 'remote' },
        { installTarget: 'remote' },
        { installTarget: 'remote' }
      ])
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})

function requireCloudFixture(): RemoteSkillCloudFixture {
  if (!cloud) {
    throw new Error('skill Cloud fixture unavailable')
  }
  return cloud
}

async function installAndVerify(
  page: Page,
  target: DockerSshRelayTarget,
  destination: SkillInstallDestination,
  remotePath: string
): Promise<void> {
  const operation = await page.evaluate(
    ({ destination, packageId, versionId }) =>
      window.api.skills.installPackageVersion({
        packageId,
        versionId,
        destination
      }),
    {
      destination,
      packageId: REMOTE_SKILL_PACKAGE_ID,
      versionId: REMOTE_SKILL_VERSION_ID
    }
  )
  expect(operation, JSON.stringify(operation, null, 2)).toMatchObject({
    status: 'ok',
    value: { status: 'installed', name: REMOTE_SKILL_NAME }
  })
  const contents = execDockerSshRelayTargetCommand(target, `cat ${remotePath}/SKILL.md`)
  expect(contents).toContain('# Remote E2E')
}

async function previewUnchanged(page: Page, destination: SkillInstallDestination): Promise<void> {
  const fixture = requireCloudFixture()
  const preview = await page.evaluate(
    ({ destination, packageIdentity, name }) =>
      window.api.skills.previewInstall({
        package: packageIdentity,
        name,
        destination
      }),
    {
      destination,
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
}

async function removeAndVerify(
  page: Page,
  target: DockerSshRelayTarget,
  destination: SkillInstallDestination,
  remotePath: string
): Promise<void> {
  const operation = await page.evaluate(
    ({ destination, name }) => window.api.skills.removeInstall({ name, destination }),
    { destination, name: REMOTE_SKILL_NAME }
  )
  expect(operation).toMatchObject({ status: 'ok', value: { status: 'removed' } })
  expect(execDockerSshRelayTargetCommand(target, `test ! -e ${remotePath} && echo removed`)).toBe(
    'removed'
  )
}

async function createRemoteFolderWorkspace(page: Page, targetId: string): Promise<string> {
  return page.evaluate(
    async ({ targetId, folderPath }) => {
      const group = await window.api.projectGroups.create({
        name: 'SSH skill folder E2E',
        parentPath: folderPath,
        connectionId: targetId
      })
      const workspace = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'SSH skill folder E2E',
        folderPath,
        connectionId: targetId
      })
      return workspace.id
    },
    { targetId, folderPath: REMOTE_FOLDER }
  )
}
