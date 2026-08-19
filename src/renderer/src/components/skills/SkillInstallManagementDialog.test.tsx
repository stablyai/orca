// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSkillInstall } from '../../../../shared/skill-install-contract'
import type {
  SkillCloudPackageDetails,
  SkillCloudVersion
} from '../../../../shared/skill-cloud-contract'
import { useAppStore } from '@/store'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from '@/hooks/installed-agent-skills-change-event'
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
    deletePackageVersion: vi.fn().mockResolvedValue({ status: 'ok', value: undefined }),
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

const ROW_ACTION = /Reinstall|Use this version/

function dateLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(iso))
}

async function openInstall(name = 'private-skill'): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  await screen.findByRole('button', { name: ROW_ACTION })
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
  it('ignores a stale install list after switching machines', async () => {
    useAppStore.setState({
      runtimeEnvironments: [
        {
          id: 'remote_1',
          name: 'Remote',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [
            {
              id: 'remote_ws',
              kind: 'websocket',
              label: 'WebSocket',
              endpoint: 'ws://remote.invalid'
            }
          ],
          preferredEndpointId: 'remote_ws'
        }
      ]
    })
    const skills = skillsApi(install('local_version'), [
      version('local_version', '2026-08-12T00:00:00.000Z')
    ])
    let resolveLocal: ((value: unknown) => void) | undefined
    skills.listManagedInstalls
      .mockImplementationOnce(() => new Promise((resolve) => (resolveLocal = resolve)) as never)
      .mockResolvedValueOnce({
        status: 'ok',
        value: [{ ...install('remote_version'), name: 'remote-skill' }]
      })
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'Remote' }))
    await screen.findByText('remote-skill · Everywhere')
    resolveLocal?.({ status: 'ok', value: [install('local_version')] })

    await waitFor(() => expect(screen.queryByText('private-skill · Everywhere')).toBeNull())
    expect(screen.getByText('remote-skill · Everywhere')).toBeTruthy()
  })

  it('ignores stale package details after switching machines', async () => {
    useAppStore.setState({
      runtimeEnvironments: [
        {
          id: 'remote_1',
          name: 'Remote',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [
            {
              id: 'remote_ws',
              kind: 'websocket',
              label: 'WebSocket',
              endpoint: 'ws://remote.invalid'
            }
          ],
          preferredEndpointId: 'remote_ws'
        }
      ]
    })
    const remoteInstall = {
      ...install('remote_version'),
      name: 'remote-skill',
      packageId: 'pkg_remote'
    }
    const skills = skillsApi(install('local_version'), [
      version('local_version', '2026-08-12T00:00:00.000Z')
    ])
    let resolveLocalDetails: ((value: unknown) => void) | undefined
    skills.listManagedInstalls
      .mockResolvedValueOnce({ status: 'ok', value: [install('local_version')] })
      .mockResolvedValueOnce({ status: 'ok', value: [remoteInstall] })
    skills.getPackage
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveLocalDetails = resolve)) as never
      )
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          ...packageDetails([version('remote_version', '2026-08-13T00:00:00.000Z')]),
          id: 'pkg_remote',
          name: 'remote-skill'
        }
      })
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)

    await screen.findByText('private-skill · Everywhere')
    fireEvent.click(screen.getByRole('button', { name: /private-skill/ }))
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'Remote' }))
    fireEvent.click(await screen.findByRole('button', { name: /remote-skill/ }))
    const remoteLabel = `${dateLabel('2026-08-13T00:00:00.000Z')} (installed)`
    await screen.findByText(remoteLabel)

    resolveLocalDetails?.({
      status: 'ok',
      value: packageDetails([version('local_version', '2026-08-12T00:00:00.000Z')])
    })
    // Why: the stale local details would repaint the version picker with the
    // local build's date.
    await waitFor(() =>
      expect(screen.queryByText(dateLabel('2026-08-12T00:00:00.000Z'))).toBeNull()
    )
    expect(screen.getByText(remoteLabel)).toBeTruthy()
  })

  it('updates an installed skill to the newest immutable version', async () => {
    const skills = skillsApi(install('ver_1'), [
      version('ver_2', '2026-08-12T00:00:00.000Z'),
      version('ver_1', '2026-08-11T00:00:00.000Z')
    ])
    const changed = vi.fn()
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, changed)
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)
    await openInstall()

    fireEvent.click(screen.getByRole('button', { name: 'Use this version' }))

    await waitFor(() => expect(skills.installPackageVersion).toHaveBeenCalledOnce())
    expect(skills.installPackageVersion).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'pkg_1', versionId: 'ver_2' })
    )
    expect(changed).toHaveBeenCalledOnce()
    window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, changed)
  })

  it('does not invalidate discovery after a failed local mutation', async () => {
    const skills = skillsApi(install('ver_1'), [
      version('ver_2', '2026-08-12T00:00:00.000Z'),
      version('ver_1', '2026-08-11T00:00:00.000Z')
    ])
    skills.installPackageVersion.mockResolvedValue({
      status: 'ok',
      value: {
        operationId: 'operation_failed',
        status: 'failed',
        name: 'private-skill',
        packageDigest: DIGEST,
        placements: []
      }
    })
    const changed = vi.fn()
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, changed)
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)
    await openInstall()

    fireEvent.click(screen.getByRole('button', { name: 'Use this version' }))

    await waitFor(() => expect(skills.installPackageVersion).toHaveBeenCalledOnce())
    expect(changed).not.toHaveBeenCalled()
    window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, changed)
  })

  it('rolls an installed skill back to an older immutable version', async () => {
    const skills = skillsApi(install('ver_2'), [
      version('ver_1', '2026-08-11T00:00:00.000Z'),
      version('ver_2', '2026-08-12T00:00:00.000Z')
    ])
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)
    await openInstall()

    fireEvent.click(screen.getByRole('button', { name: 'Use this version' }))

    await waitFor(() => expect(skills.installPackageVersion).toHaveBeenCalledOnce())
    expect(skills.installPackageVersion).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'pkg_1', versionId: 'ver_1' })
    )
  })

  it('requires confirmation before removing an Orca-managed install', async () => {
    const skills = skillsApi(install('ver_2'), [version('ver_2', '2026-08-12T00:00:00.000Z')])
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)
    await openInstall()

    const remove = screen.getByRole('button', { name: 'Remove' })
    remove.focus()
    fireEvent.click(remove)
    expect(skills.removeInstall).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: 'Confirm remove' })
    expect(document.activeElement).toBe(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(skills.removeInstall).toHaveBeenCalledOnce())
    expect(skills.removeInstall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'private-skill', destination: { scope: 'global' } })
    )
  })

  it('allows removal when Cloud package history is unavailable', async () => {
    const skills = skillsApi(install('ver_2'), [version('ver_2', '2026-08-12T00:00:00.000Z')])
    skills.getPackage.mockResolvedValue({
      status: 'unsupported',
      message: 'Package history is unavailable.'
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /private-skill/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }))

    await waitFor(() => expect(skills.removeInstall).toHaveBeenCalledOnce())
  })

  it('retries incomplete coverage for the currently installed version', async () => {
    const skills = skillsApi(install('ver_1'), [
      version('ver_2', '2026-08-12T00:00:00.000Z'),
      version('ver_1', '2026-08-11T00:00:00.000Z')
    ])
    skills.installPackageVersion.mockResolvedValue({
      status: 'ok',
      value: {
        operationId: 'operation_partial',
        status: 'partial',
        name: 'private-skill',
        packageDigest: DIGEST,
        placements: [
          {
            provider: 'codex',
            path: '/redacted-in-ui',
            topology: 'provider-alias',
            status: 'failed',
            errorCategory: 'skill-placement-permission-denied'
          }
        ]
      }
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)
    await openInstall()

    fireEvent.click(screen.getByRole('button', { name: 'Use this version' }))
    await screen.findByRole('button', { name: 'Finish installing' })
    fireEvent.click(screen.getByRole('button', { name: 'Finish installing' }))

    await waitFor(() => expect(skills.installPackageVersion).toHaveBeenCalledTimes(2))
    expect(skills.installPackageVersion.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ packageId: 'pkg_1', versionId: 'ver_2' })
    )
  })

  it('groups bundle receipts and updates only the managed bundle skills', async () => {
    const installed = [bundleInstall('alpha-skill'), bundleInstall('beta-skill')]
    const bundle = bundleVersion('ver_2', ['alpha-skill', 'beta-skill', 'new-skill'])
    const skills = skillsApi(installed, [bundle])
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill \+1/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this version' }))

    await waitFor(() => expect(skills.installBundlePackageVersion).toHaveBeenCalledOnce())
    expect(skills.installBundlePackageVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: 'pkg_1',
        versionId: 'ver_2',
        selectedSkillIds: ['alpha-skill', 'beta-skill']
      })
    )
    expect(skills.installPackageVersion).not.toHaveBeenCalled()
  })

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

  it('removes a bundle with one confirmation and preserves modified skills', async () => {
    const installed = [bundleInstall('alpha-skill'), bundleInstall('beta-skill', 'modified')]
    const skills = skillsApi(installed, [bundleVersion('ver_1', ['alpha-skill', 'beta-skill'])])
    skills.removeInstall
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          operationId: 'remove_alpha',
          status: 'removed',
          name: 'alpha-skill',
          packageDigest: DIGEST,
          placements: []
        }
      })
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          operationId: 'keep_beta',
          status: 'conflict',
          name: 'beta-skill',
          packageDigest: DIGEST,
          placements: []
        }
      })
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill \+1/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }))

    await screen.findByText('1 removed · 1 modified skill preserved.')
    expect(skills.removeInstall).toHaveBeenCalledTimes(2)
    expect(skills.removeInstall.mock.calls).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ name: 'alpha-skill' })],
        [expect.objectContaining({ name: 'beta-skill' })]
      ])
    )
    expect(skills.removeInstall.mock.calls[1]?.[0]).not.toHaveProperty('conflictResolution')
  })

  it('discards changes and removes every skill in a mixed-state bundle', async () => {
    const installed = [bundleInstall('alpha-skill'), bundleInstall('beta-skill', 'modified')]
    const skills = skillsApi(installed, [bundleVersion('ver_1', ['alpha-skill', 'beta-skill'])])
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallManagementDialog open onOpenChange={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill \+1/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard my edits and remove' }))

    await waitFor(() => expect(skills.removeInstall).toHaveBeenCalledTimes(2))
    expect(skills.removeInstall.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            name: 'alpha-skill',
            conflictResolution: 'replace-and-discard-local'
          })
        ],
        [
          expect.objectContaining({
            name: 'beta-skill',
            conflictResolution: 'replace-and-discard-local'
          })
        ]
      ])
    )
  })
})
