// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import type { SkillInstallProgress } from '../../../../shared/skill-sharing-contract'
import { useAppStore } from '@/store'
import { SkillInstallDialog } from './SkillInstallDialog'

const DIGEST = 'a'.repeat(64)
const ARCHIVE_SHA = 'b'.repeat(64)

function version(): SkillCloudVersion {
  return {
    packageId: 'pkg_1',
    versionId: 'ver_1',
    name: 'private-skill',
    description: 'A private skill',
    packageDigest: DIGEST,
    archiveSha256: ARCHIVE_SHA,
    compressedBytes: 128,
    createdAt: '2026-08-11T00:00:00.000Z',
    releaseNotes: '',
    manifest: {
      schemaVersion: 1,
      packageId: 'pkg_1',
      versionId: 'ver_1',
      name: 'private-skill',
      description: 'A private skill',
      createdAt: '2026-08-11T00:00:00.000Z',
      files: [
        {
          path: 'SKILL.md',
          size: 1,
          executable: false,
          classification: 'text',
          sha256: DIGEST,
          identitySha256: DIGEST
        }
      ],
      packageDigest: DIGEST
    }
  }
}

function installApi(previewInstall: ReturnType<typeof vi.fn>) {
  let progressListener: ((progress: SkillInstallProgress) => void) | null = null
  return {
    resolveShare: vi
      .fn()
      .mockResolvedValue({ status: 'ok', value: { id: 'share_1', version: version() } }),
    previewInstall,
    previewBundleInstall: vi.fn(),
    installShare: vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        operationId: 'op_1',
        status: 'installed',
        name: 'private-skill',
        packageDigest: DIGEST,
        placements: []
      }
    }),
    installBundleShare: vi.fn(),
    cancelInstall: vi.fn().mockResolvedValue({ cancelled: true }),
    listWslDistros: vi.fn().mockResolvedValue([]),
    onInstallProgress: vi.fn((listener) => {
      progressListener = listener
      return () => {
        progressListener = null
      }
    }),
    emitInstallProgress: (progress: SkillInstallProgress) => progressListener?.(progress)
  }
}

async function inspectSkill(expectedDescription = 'A private skill'): Promise<void> {
  fireEvent.change(screen.getByLabelText('Orca skill link'), {
    target: { value: 'https://app.orca.dev/skills/share/share_1' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Inspect skill' }))
  await screen.findByText(expectedDescription)
}

beforeEach(() => {
  useAppStore.setState({
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map()
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('SkillInstallDialog', () => {
  it('preserves a modified install until the user explicitly discards it', async () => {
    const previewInstall = vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        name: 'private-skill',
        packageDigest: DIGEST,
        destinationIdentity: 'local:global',
        currentState: 'modified',
        providers: []
      }
    })
    const skills = installApi(previewInstall)
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))
    expect((await screen.findByRole('alert')).textContent).toContain('left it untouched')
    expect(skills.installShare).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard and replace' }))
    await waitFor(() => expect(skills.installShare).toHaveBeenCalledOnce())
    expect(skills.installShare).toHaveBeenCalledWith(
      expect.objectContaining({ conflictResolution: 'replace-and-discard-local' })
    )
  })

  it('surfaces capability loss after preview selection without attempting installation', async () => {
    const previewInstall = vi.fn().mockResolvedValue({
      status: 'unsupported',
      message: 'Update the selected Orca host to install shared skills.'
    })
    const skills = installApi(previewInstall)
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Update the selected Orca host'
    )
    expect(skills.installShare).not.toHaveBeenCalled()
  })
})
