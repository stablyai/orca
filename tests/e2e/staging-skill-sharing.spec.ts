import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { SkillBundleInstallResult } from '../../src/shared/skill-bundle-install-contract'
import type { SkillCloudPublishResult } from '../../src/shared/skill-cloud-contract'
import type { SkillInstallDestination } from '../../src/shared/skill-install-contract'
import type {
  SkillBundleShareInstallOperation,
  SkillSharePreview
} from '../../src/shared/skill-sharing-contract'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  connectStagingSkillSshTarget,
  removeStagingSkillSshTarget,
  stagingSkillSshTargetFromEnvironment
} from './helpers/staging-skill-ssh-target'

const RUN_STAGING = process.env.ORCA_E2E_SKILL_STAGING === '1'
const AUTH_TOKEN = process.env.ORCA_CLOUD_AUTH_TOKEN?.trim()
const PHYSICAL_HOST_PAIRING_URL = process.env.ORCA_E2E_SKILL_PHYSICAL_PAIRING_URL?.trim()
const RUN_HEADLESS_PAIRED = process.env.ORCA_E2E_SKILL_PAIRED_HEADLESS === '1'
const PHYSICAL_WSL_DISTRO = 'Ubuntu-24.04'
const SKILL_NAME = `orca-staging-${randomUUID().slice(0, 8)}`
const SSH_TARGET = RUN_STAGING ? stagingSkillSshTargetFromEnvironment() : null

if (RUN_STAGING && !AUTH_TOKEN) {
  throw new Error('ORCA_CLOUD_AUTH_TOKEN is required for the noninteractive staging journey.')
}
if (PHYSICAL_HOST_PAIRING_URL && RUN_HEADLESS_PAIRED) {
  throw new Error('staging physical pairing and headless pairing are mutually exclusive')
}

test.use({
  orcaAppExtraEnv: {
    ORCA_ARTIFACTS_API_URL: 'https://cloud-api-staging.onorca.dev',
    ORCA_CLOUD_API_URL: 'https://auth-staging.onorca.dev',
    ORCA_CLOUD_AUTH_URL: 'https://auth-staging.onorca.dev',
    ORCA_CLOUD_CLIENT_ID: 'orca-desktop',
    ...(AUTH_TOKEN ? { ORCA_CLOUD_AUTH_TOKEN: AUTH_TOKEN } : {})
  }
})

test.skip(!RUN_STAGING, 'Set ORCA_E2E_SKILL_STAGING=1 to run the live staging journey.')
test.describe.configure({ mode: 'serial' })

test('publishes, updates, revokes, and deletes without losing local state', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(12 * 60_000)
  const sourceRoot = mkdtempSync(join(tmpdir(), 'orca-staging-skill-source-'))
  const source = join(sourceRoot, '.agents', 'skills', SKILL_NAME)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const globalSkill = join(home, '.agents', 'skills', SKILL_NAME)
  let packageId: string | null = null
  let physicalEnvironmentId: string | null = null
  let pairedHost: HeadlessPairedRuntimeHost | null = null
  let sshTargetId: string | null = null
  try {
    if (RUN_HEADLESS_PAIRED) {
      pairedHost = await launchHeadlessPairedRuntimeHost()
      physicalEnvironmentId = await addPhysicalHost(orcaPage, pairedHost.offer.pairingUrl)
    } else if (PHYSICAL_HOST_PAIRING_URL) {
      physicalEnvironmentId = await addPhysicalHost(orcaPage, PHYSICAL_HOST_PAIRING_URL)
    }
    if (SSH_TARGET) {
      sshTargetId = await connectStagingSkillSshTarget(orcaPage, SSH_TARGET)
    }
    mkdirSync(source, { recursive: true })
    writeSkill(source, 'v1')
    const first = await publish(
      orcaPage,
      sourceRoot,
      'Initial staging journey',
      undefined,
      (preview) => {
        packageId = preview.packageId
      }
    )
    for (const target of externalTargets(physicalEnvironmentId, sshTargetId)) {
      const remoteFirst = await installVersion(
        orcaPage,
        first.published,
        target.destination,
        undefined,
        target.installEnvironmentId
      )
      expectPhysicalInstall(remoteFirst, first.published, target.kind)
      expect(existsSync(globalSkill)).toBe(false)
    }
    const firstInstall = await installVersion(orcaPage, first.published, { scope: 'global' })
    expectBundleOutcome(firstInstall, 'complete', 'installed')
    expect(readFileSync(join(globalSkill, 'SKILL.md'), 'utf8')).toContain('version: v1')

    writeSkill(globalSkill, 'local')
    writeSkill(source, 'v2')
    const second = await publish(
      orcaPage,
      sourceRoot,
      'Second immutable version',
      first.preview.packageId
    )
    for (const target of externalTargets(physicalEnvironmentId, sshTargetId)) {
      const remoteUpdate = await installVersion(
        orcaPage,
        second.published,
        target.destination,
        'replace-unmodified',
        target.installEnvironmentId
      )
      expectBundleOutcome(remoteUpdate, 'complete', 'updated')
      await expectManagedRemoteVersion(orcaPage, target, second.published.version.versionId)
    }
    const conflict = await installVersion(orcaPage, second.published, { scope: 'global' })
    expectBundleOutcome(conflict, 'partial', 'kept-local', 'modified')
    expect(readFileSync(join(globalSkill, 'SKILL.md'), 'utf8')).toContain('version: local')

    const update = await installVersion(
      orcaPage,
      second.published,
      { scope: 'global' },
      'replace-and-discard-local'
    )
    expectBundleOutcome(update, 'complete', 'updated')
    expect(readFileSync(join(globalSkill, 'SKILL.md'), 'utf8')).toContain('version: v2')

    const rollback = await installVersion(
      orcaPage,
      first.published,
      { scope: 'global' },
      'replace-unmodified'
    )
    expectBundleOutcome(rollback, 'complete', 'updated')
    expect(readFileSync(join(globalSkill, 'SKILL.md'), 'utf8')).toContain('version: v1')

    for (const target of externalTargets(physicalEnvironmentId, sshTargetId)) {
      const remoteRollback = await installVersion(
        orcaPage,
        first.published,
        target.destination,
        'replace-unmodified',
        target.installEnvironmentId
      )
      expectBundleOutcome(remoteRollback, 'complete', 'updated')
      await expectManagedRemoteVersion(orcaPage, target, first.published.version.versionId)
    }

    expect(
      await orcaPage.evaluate(
        (shareId) => window.api.skills.revokeShare(shareId),
        first.published.share.id
      )
    ).toMatchObject({ status: 'ok' })
    const revokedInstall = await orcaPage.evaluate(
      async ({ shareId, skillId, versionId }) => {
        try {
          return await window.api.skills.installBundleShare({
            shareId,
            versionId,
            selectedSkillIds: [skillId],
            destination: { scope: 'global' }
          })
        } catch {
          return { status: 'rejected' as const }
        }
      },
      {
        shareId: first.published.share.id,
        skillId: bundleSkillId(first.published),
        versionId: first.published.version.versionId
      }
    )
    expect(revokedInstall.status).toBe('rejected')
    expect(readFileSync(join(globalSkill, 'SKILL.md'), 'utf8')).toContain('version: v1')

    for (const target of externalTargets(physicalEnvironmentId, sshTargetId)) {
      await expectManagedRemoteVersion(orcaPage, target, first.published.version.versionId)
      expect(
        await orcaPage.evaluate(
          ({ environmentId, name, destination }) =>
            window.api.skills.removeInstall({
              ...(environmentId ? { environmentId } : {}),
              name,
              destination
            }),
          {
            environmentId: target.installEnvironmentId,
            name: SKILL_NAME,
            destination: target.destination
          }
        )
      ).toMatchObject({ status: 'ok', value: { status: 'removed' } })
    }

    const removed = await orcaPage.evaluate(
      (name) => window.api.skills.removeInstall({ name, destination: { scope: 'global' } }),
      SKILL_NAME
    )
    expect(removed).toMatchObject({ status: 'ok', value: { status: 'removed' } })
    expect(existsSync(globalSkill)).toBe(false)
    expect(
      await orcaPage.evaluate((id) => window.api.skills.getPackage(id), packageId)
    ).toMatchObject({ status: 'ok' })
    expect(
      await orcaPage.evaluate((id) => window.api.skills.deletePackage(id), packageId)
    ).toMatchObject({ status: 'ok' })
    packageId = null
  } finally {
    for (const target of externalTargets(physicalEnvironmentId, sshTargetId)) {
      await orcaPage
        .evaluate(
          ({ environmentId, name, destination }) =>
            window.api.skills.removeInstall({
              ...(environmentId ? { environmentId } : {}),
              name,
              destination,
              conflictResolution: 'replace-and-discard-local'
            }),
          {
            environmentId: target.installEnvironmentId,
            name: SKILL_NAME,
            destination: target.destination
          }
        )
        .catch(() => undefined)
    }
    if (sshTargetId) {
      await removeStagingSkillSshTarget(orcaPage, sshTargetId).catch(() => undefined)
    }
    if (physicalEnvironmentId) {
      await orcaPage
        .evaluate(
          (selector) => window.api.runtimeEnvironments.remove({ selector }),
          physicalEnvironmentId
        )
        .catch(() => undefined)
    }
    await pairedHost?.dispose().catch(() => undefined)
    if (packageId) {
      await orcaPage
        .evaluate((id) => window.api.skills.deletePackage(id), packageId)
        .catch(() => undefined)
    }
    rmSync(globalSkill, { recursive: true, force: true })
    rmSync(sourceRoot, { recursive: true, force: true })
  }
})

function writeSkill(directory: string, version: string): void {
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: Orca staging installation journey\n---\n\n# Staging journey\n\nversion: ${version}\n`
  )
}

async function publish(
  page: Page,
  cwd: string,
  releaseNotes: string,
  packageId?: string,
  onPrepared?: (preview: SkillSharePreview) => void
): Promise<{ preview: SkillSharePreview; published: SkillCloudPublishResult }> {
  const sourceDirectory = join(cwd, '.agents', 'skills', SKILL_NAME)
  const skill = await page.evaluate(
    async ({ cwd, sourceDirectory }) =>
      (await window.api.skills.discover({ cwd })).skills.find(
        (candidate) => candidate.directoryPath === sourceDirectory
      ),
    { cwd, sourceDirectory }
  )
  if (!skill) {
    throw new Error('staging skill source was not discovered')
  }
  const preview = await page.evaluate(
    ({ skillId, bundleName, cwd, packageId }) =>
      window.api.skills.prepareShare({
        skillIds: [skillId],
        bundleName,
        target: { cwd },
        ...(packageId ? { packageId } : {})
      }),
    { skillId: skill.id, bundleName: SKILL_NAME, cwd, packageId }
  )
  onPrepared?.(preview)
  const operation = await page.evaluate(
    ({ preparationId, releaseNotes }) =>
      window.api.skills.publishShare({ preparationId, releaseNotes }),
    { preparationId: preview.preparationId, releaseNotes }
  )
  expect(operation.status).toBe('ok')
  if (operation.status !== 'ok') {
    throw new Error(`staging publish failed: ${operation.status}`)
  }
  return { preview, published: operation.value }
}

function installVersion(
  page: Page,
  published: SkillCloudPublishResult,
  destination: SkillInstallDestination,
  conflictResolution?: 'replace-unmodified' | 'replace-and-discard-local',
  environmentId?: string
) {
  const skillId = bundleSkillId(published)
  return page.evaluate(
    ({ packageId, versionId, skillId, destination, conflictResolution, environmentId }) =>
      window.api.skills.installBundlePackageVersion({
        packageId,
        versionId,
        selectedSkillIds: [skillId],
        destination,
        ...(environmentId ? { environmentId } : {}),
        ...(conflictResolution
          ? { conflictDecisions: [{ skillId, resolution: conflictResolution }] }
          : {})
      }),
    {
      packageId: published.version.packageId,
      versionId: published.version.versionId,
      skillId,
      destination,
      conflictResolution,
      environmentId
    }
  )
}

async function addPhysicalHost(page: Page, pairingUrl: string): Promise<string> {
  return page.evaluate(async (pairingCode) => {
    const store = window.__store
    if (!store) {
      throw new Error('staging client store is unavailable')
    }
    const result = await window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Skill staging physical host',
      pairingCode
    })
    store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
    if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
      throw new Error('physical staging host is unreachable')
    }
    return result.environment.id
  }, pairingUrl)
}

type ExternalTarget = {
  installEnvironmentId?: string
  managedEnvironmentId: string
  kind: 'paired-posix' | 'windows' | 'wsl' | 'ssh'
  destination: SkillInstallDestination
}

function externalTargets(
  environmentId: string | null,
  sshTargetId: string | null
): ExternalTarget[] {
  return [
    ...(environmentId
      ? RUN_HEADLESS_PAIRED
        ? [
            {
              installEnvironmentId: environmentId,
              managedEnvironmentId: environmentId,
              kind: 'paired-posix' as const,
              destination: { scope: 'global' as const }
            }
          ]
        : [
            {
              installEnvironmentId: environmentId,
              managedEnvironmentId: environmentId,
              kind: 'windows' as const,
              destination: { scope: 'global' as const }
            },
            {
              installEnvironmentId: environmentId,
              managedEnvironmentId: environmentId,
              kind: 'wsl' as const,
              destination: {
                scope: 'global' as const,
                executionTarget: { kind: 'wsl' as const, distro: PHYSICAL_WSL_DISTRO }
              }
            }
          ]
      : []),
    ...(sshTargetId
      ? [
          {
            managedEnvironmentId: `ssh:${sshTargetId}`,
            kind: 'ssh' as const,
            destination: {
              scope: 'global' as const,
              executionTarget: { kind: 'ssh' as const, connectionId: sshTargetId }
            }
          }
        ]
      : [])
  ]
}

function expectPhysicalInstall(
  operation: SkillBundleShareInstallOperation,
  published: SkillCloudPublishResult,
  target: ExternalTarget['kind']
): void {
  expectBundleOutcome(operation, 'complete', 'installed')
  if (operation.status !== 'ok') {
    throw new Error('physical host install failed')
  }
  const skill = operation.value.skills[0]
  expect(skill?.digest).toBe(bundleSkillDigest(published))
  if (target === 'windows') {
    expect(skill?.canonicalPath).toMatch(/^[A-Za-z]:[\\/]/)
    expect(skill?.canonicalPath).toContain(`.agents\\skills\\${SKILL_NAME}`)
  } else if (target === 'wsl') {
    expect(skill?.canonicalPath).toMatch(/^\/home\/[^/]+\/\.agents\/skills\//)
    expect(skill?.canonicalPath.endsWith(`/${SKILL_NAME}`)).toBe(true)
  } else {
    expect(skill?.canonicalPath).toMatch(/^\//)
    expect(skill?.canonicalPath.endsWith(`/.agents/skills/${SKILL_NAME}`)).toBe(true)
  }
}

async function expectManagedRemoteVersion(
  page: Page,
  target: ExternalTarget,
  versionId: string
): Promise<void> {
  const installs = await page.evaluate(
    (id) => window.api.skills.listManagedInstalls(id),
    target.managedEnvironmentId
  )
  if (installs.status !== 'ok') {
    throw new Error(`physical host managed-install listing failed: ${installs.status}`)
  }
  const install = installs.value.find((candidate) => {
    if (target.kind === 'windows' || target.kind === 'paired-posix') {
      return candidate.destination.scope === 'global' && !candidate.destination.executionTarget
    }
    if (target.kind === 'wsl') {
      return (
        candidate.destination.scope === 'global' &&
        candidate.destination.executionTarget?.kind === 'wsl' &&
        candidate.destination.executionTarget.distro === PHYSICAL_WSL_DISTRO
      )
    }
    return (
      candidate.destination.scope === 'global' &&
      candidate.destination.executionTarget?.kind === 'ssh' &&
      candidate.destination.executionTarget.connectionId ===
        target.destination.executionTarget?.connectionId
    )
  })
  expect(install).toMatchObject({
    name: SKILL_NAME,
    versionId,
    scope: 'global',
    state: 'unchanged',
    destination: target.destination
  })
}

function bundleSkillId(published: SkillCloudPublishResult): string {
  const manifest = published.version.manifest
  if (!('skills' in manifest) || manifest.skills.length !== 1) {
    throw new Error('staging publish did not return the expected one-skill bundle')
  }
  return manifest.skills[0].id
}

function bundleSkillDigest(published: SkillCloudPublishResult): string {
  const manifest = published.version.manifest
  if (!('skills' in manifest) || manifest.skills.length !== 1) {
    throw new Error('staging publish did not return the expected one-skill bundle')
  }
  return manifest.skills[0].digest
}

function expectBundleOutcome(
  operation: SkillBundleShareInstallOperation,
  expectedStatus: SkillBundleInstallResult['status'],
  expectedSkillStatus: SkillBundleInstallResult['skills'][number]['status'],
  expectedConflict?: NonNullable<SkillBundleInstallResult['skills'][number]['conflict']>['kind']
): void {
  if (operation.status !== 'ok') {
    throw new Error(`staging bundle install operation failed: ${operation.status}`)
  }
  const diagnostic = JSON.stringify({
    status: operation.value.status,
    skills: operation.value.skills.map((skill) => ({
      status: skill.status,
      errorCategory: skill.errorCategory,
      failure: skill.failure,
      conflict: skill.conflict?.kind
    }))
  })
  expect(operation.value.status, diagnostic).toBe(expectedStatus)
  expect(operation.value.skills, diagnostic).toHaveLength(1)
  expect(operation.value.skills[0]?.status, diagnostic).toBe(expectedSkillStatus)
  expect(operation.value.skills[0]?.conflict?.kind, diagnostic).toBe(expectedConflict)
}
