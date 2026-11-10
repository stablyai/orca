// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSkillInstall } from '../../../../../shared/skill-install-contract'
import type {
  SkillCloudPackageDetails,
  SkillCloudVersion
} from '../../../../../shared/skill-cloud-contract'
import { useAppStore } from '@/store/index'

import { SkillInstallManagementDialog } from './SkillInstallManagementDialog'

const DIGEST = 'a'.repeat(64)
const ARCHIVE_SHA = 'b'.repeat(64)

function version(versionId: string, createdAt: string): SkillCloudVersion {
  return {
    packageId: 'pkg_1',
    versionId,
    name: 'private-skill',
    description: 'Private skill',
    packageDigest: DIGEST,
    archiveSha256: ARCHIVE_SHA,
    compressedBytes: 128,
    createdAt,
    releaseNotes: '',
    manifest: {
      schemaVersion: 1,
      packageId: 'pkg_1',
      versionId,
      name: 'private-skill',
      description: 'Private skill',
      createdAt,
      files: [],
      packageDigest: DIGEST
    }
  }
}

function install(versionId: string): ManagedSkillInstall {
  return {
    name: 'private-skill',
    packageId: 'pkg_1',
    versionId,
    packageDigest: DIGEST,
    scope: 'global',
    destinationIdentity: 'global:local',
    destination: { scope: 'global' },
    installedAt: '2026-08-11T00:00:00.000Z',
    state: 'unchanged'
  }
}

function packageDetails(versions: SkillCloudVersion[]): SkillCloudPackageDetails {
  return {
    id: 'pkg_1',
    name: 'private-skill',
    description: 'Private skill',
    createdAt: versions.at(-1)?.createdAt ?? '2026-08-11T00:00:00.000Z',
    canManage: true,
    versions
  }
}

function skillsApi(
  installedInput: ManagedSkillInstall | ManagedSkillInstall[],
  versions: SkillCloudVersion[],
  details = packageDetails(versions)
) {
  const installed = Array.isArray(installedInput) ? installedInput : [installedInput]
  let progressListener:
    | ((progress: { operationId: string; phase: 'authorizing' | 'installing' }) => void)
    | null = null
  return {
    listManagedInstalls: vi.fn().mockResolvedValue({ status: 'ok', value: installed }),
    getPackage: vi.fn().mockResolvedValue({ status: 'ok', value: details }),
    installPackageVersion: vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        operationId: 'operation_1',
        status: 'updated',
        name: installed[0]?.name ?? 'private-skill',
        packageDigest: DIGEST,
        placements: []
      }
    }),
    installBundlePackageVersion: vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        operationId: 'operation_bundle',
        packageId: 'pkg_1',
        versionId: versions[0]?.versionId ?? 'ver_1',
        bundleDigest: DIGEST,
        status: 'complete',
        skills: installed.map((skill) => ({
          skillId: skill.name,
          name: skill.name,
          digest: skill.packageDigest,
          status: 'updated',
          placements: []
        }))
      }
    }),
    removeInstall: vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        operationId: 'operation_2',
        status: 'removed',
        name: installed[0]?.name ?? 'private-skill',
        packageDigest: DIGEST,
        placements: []
      }
    }),
    revokeShare: vi.fn().mockResolvedValue({ status: 'ok', value: undefined }),
    deletePackage: vi.fn().mockResolvedValue({ status: 'ok', value: undefined }),
    cancelInstall: vi.fn().mockResolvedValue({ cancelled: true }),
    onInstallProgress: vi.fn((listener) => {
      progressListener = listener
      return () => {
        progressListener = null
      }
    }),
    emitInstallProgress: (progress: { operationId: string; phase: 'authorizing' | 'installing' }) =>
      progressListener?.(progress)
  }
}

function bundleVersion(versionId: string, names: string[]): SkillCloudVersion {
  const createdAt = '2026-08-12T00:00:00.000Z'
  return {
    ...version(versionId, createdAt),
    name: 'team-skills',
    manifest: {
      schemaVersion: 1,
      packageId: 'pkg_1',
      versionId,
      bundleName: 'team-skills',
      description: 'Team skills',
      createdAt,
      bundleDigest: DIGEST,
      skills: names.map((name) => ({
        id: name,
        name,
        description: `${name} description`,
        digest: DIGEST,
        files: []
      }))
    }
  }
}

function bundleInstall(name: string, state: ManagedSkillInstall['state'] = 'unchanged') {
  return { ...install('ver_1'), name, bundleDigest: DIGEST, state }
}

beforeEach(() => {
  useAppStore.setState({
    runtimeEnvironments: [],
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    pendingSkillShareId: null
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('SkillInstallManagementDialog', () => {
  it('opens an active bundle link in the existing machine installer', async () => {
    const installed = [bundleInstall('alpha-skill'), bundleInstall('beta-skill')]
    const versions = [bundleVersion('ver_1', ['alpha-skill', 'beta-skill'])]
    const details = {
      ...packageDetails(versions),
      management: {
        shares: [
          {
            id: 'share_bundle',
            url: 'https://app.orca.dev/skills/share/share_bundle',
            createdAt: '2026-08-12T00:00:00.000Z'
          }
        ]
      }
    }
    const skills = skillsApi(installed, versions, details)
    const onOpenChange = vi.fn()
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill \+1/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Install elsewhere/ }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useAppStore.getState().pendingSkillShareId).toBe('share_bundle')
  })
})
