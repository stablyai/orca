// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

function bundleVersion(): SkillCloudVersion {
  const skill = (id: string, name: string) => ({
    id,
    name,
    description: `${name} description`,
    digest: DIGEST,
    files: [
      {
        path: 'SKILL.md',
        size: 1,
        executable: false,
        classification: 'text' as const,
        sha256: DIGEST,
        identitySha256: DIGEST
      }
    ]
  })
  return {
    ...version(),
    name: 'team-bundle',
    description: 'Two private skills',
    packageDigest: 'c'.repeat(64),
    releaseNotes: 'Initial team bundle',
    manifest: {
      schemaVersion: 1,
      packageId: 'pkg_1',
      versionId: 'ver_1',
      bundleName: 'team-bundle',
      description: 'Two private skills',
      createdAt: '2026-08-11T00:00:00.000Z',
      skills: [skill('skill-alpha', 'alpha'), skill('skill-beta', 'beta')],
      bundleDigest: 'c'.repeat(64)
    }
  }
}

function detectionApi(agents: string[]) {
  return {
    detectAgents: vi.fn().mockResolvedValue(agents),
    detectRemoteAgents: vi.fn().mockResolvedValue(agents)
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
  it('renders long Unicode metadata and multiline release notes before installation', async () => {
    const sharedVersion = version()
    const longName = `skill-${'n'.repeat(58)}`
    const releaseNotes = `First line\n${'r'.repeat(9_989)}`
    sharedVersion.name = longName
    sharedVersion.description = `説明 ${'d'.repeat(512)}`
    sharedVersion.releaseNotes = releaseNotes
    const skills = installApi(vi.fn())
    skills.resolveShare.mockResolvedValue({
      status: 'ok',
      value: { id: 'share_1', version: sharedVersion }
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)

    await inspectSkill(sharedVersion.description)
    expect(screen.getByRole('button', { name: new RegExp(longName) })).toBeTruthy()
    expect(screen.queryByText(/Published by Orca user/)).toBeNull()
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' && element.textContent === `Release notes: ${releaseNotes}`
      )
    ).toBeTruthy()
  })

  // Why: the picker is the only place a recipient can say "not Claude"; the
  // request has to carry that choice or the host installs everywhere it can.
  it('installs only for the agents left checked', async () => {
    const skills = installApi(
      vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          name: 'private-skill',
          packageDigest: DIGEST,
          destinationIdentity: 'global:local',
          currentState: 'missing',
          providers: []
        }
      })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['claude', 'codex', 'droid']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    fireEvent.click(await screen.findByRole('button', { name: /Installing for:/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Code/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))

    await waitFor(() => expect(skills.installShare).toHaveBeenCalled())
    const [request] = skills.installShare.mock.calls[0] as [{ providers: string[] }]
    expect(request.providers).not.toContain('claude')
    expect(request.providers).toContain('codex')
    expect(request.providers).toContain('droid')
  })

  it('pins installation to the version shown for review', async () => {
    const skills = installApi(
      vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          name: 'private-skill',
          packageDigest: DIGEST,
          destinationIdentity: 'global:local',
          currentState: 'missing',
          providers: []
        }
      })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))

    await waitFor(() => expect(skills.installShare).toHaveBeenCalled())
    expect(skills.installShare).toHaveBeenCalledWith(
      expect.objectContaining({ shareId: 'share_1', versionId: 'ver_1' })
    )
  })

  // Why: checking agents the machine does not have would write placements no
  // agent reads, and make the user opt out of tools they never installed.
  it('starts from the agents the target machine has', async () => {
    const skills = installApi(
      vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          name: 'private-skill',
          packageDigest: DIGEST,
          destinationIdentity: 'global:local',
          currentState: 'missing',
          providers: []
        }
      })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()
    await screen.findByRole('button', { name: 'Installing for: Codex' })

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))
    await waitFor(() => expect(skills.installShare).toHaveBeenCalled())
    const [request] = skills.installShare.mock.calls[0] as [{ providers: string[] }]
    expect(request.providers).toEqual(['codex'])
  })

  // Why: a skill description doubles as its trigger documentation and can run
  // for paragraphs; the row shows one line until the reader opens it.
  it('unclamps a long description when the row is opened', async () => {
    const sharedVersion = version()
    sharedVersion.description = `Use the public CLI. ${'trigger words.'.repeat(20)}`
    const skills = installApi(vi.fn())
    skills.resolveShare.mockResolvedValue({
      status: 'ok',
      value: { id: 'share_1', version: sharedVersion }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill(sharedVersion.description)

    const description = screen.getByText(sharedVersion.description)
    expect(description.className).toContain('line-clamp-1')
    expect(description.className).toContain('group-data-[state=open]/row:line-clamp-none')
    expect(description.className).toContain('group-data-[state=open]/row:max-h-none')
    expect(description.className).not.toContain('group-data-[state=open]/row:max-h-40')
  })

  // Why: "view the full skill contents" is the point of the row — the file list
  // is the only place a recipient sees what lands on their machine.
  it('lists the files a skill would write when its row is expanded', async () => {
    const skills = installApi(vi.fn())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    expect(screen.queryByText('SKILL.md')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /private-skill/ }))
    expect(screen.getByText('SKILL.md')).toBeTruthy()
  })

  // Why: a recipient cannot compare a digest against anything, and the badge
  // language ("Immutable version") explained nothing. Both left the review.
  it.each([
    ['skill', () => version(), 'a'],
    ['bundle', () => bundleVersion(), 'c']
  ])('keeps package plumbing out of the %s review', async (_kind, build, char) => {
    const skills = installApi(vi.fn())
    skills.resolveShare.mockResolvedValue({
      status: 'ok',
      value: { id: 'share_1', version: build() }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill('skills' in build().manifest ? 'alpha description' : build().description)

    expect(screen.queryByText(/SHA-256/)).toBeNull()
    expect(screen.queryByText(char.repeat(64))).toBeNull()
    expect(screen.queryByText('Immutable version')).toBeNull()
    expect(screen.queryByText('0 scripts')).toBeNull()
    expect(screen.getAllByText(/^1 file$/).length).toBeGreaterThan(0)
  })

  it('warns about supporting files without blocking installation', async () => {
    const sharedVersion = version()
    if (!('files' in sharedVersion.manifest)) {
      throw new Error('expected single skill')
    }
    sharedVersion.manifest.files.push({
      path: 'references/guide.md',
      size: 12,
      executable: false,
      classification: 'text',
      sha256: DIGEST,
      identitySha256: DIGEST
    })
    const skills = installApi(vi.fn())
    skills.resolveShare.mockResolvedValue({
      status: 'ok',
      value: { id: 'share_1', version: sharedVersion }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)

    await inspectSkill()
    expect(screen.getByText(/^2 files$/)).toBeTruthy()
    expect(screen.queryByText(/supporting$/, { selector: 'span' })).toBeNull()
    expect(screen.getByText('Includes supporting files')).toBeTruthy()
    expect(screen.getByText(/include 1 file beyond SKILL.md/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /I trust the sender/ })).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Install skill' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('describes selected bundle skills with runnable files without blocking installation', async () => {
    const sharedVersion = bundleVersion()
    if (!('skills' in sharedVersion.manifest)) {
      throw new Error('expected bundle')
    }
    sharedVersion.manifest.skills[0].files.push({
      path: 'release.py',
      size: 12,
      executable: false,
      classification: 'text',
      sha256: DIGEST,
      identitySha256: DIGEST
    })
    const skills = installApi(vi.fn())
    skills.resolveShare.mockResolvedValue({
      status: 'ok',
      value: { id: 'share_1', version: sharedVersion }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)

    await inspectSkill('alpha description')
    expect(screen.getByText(/1 of 2 selected skills include scripts or binary files: alpha/))
    expect(screen.queryByRole('checkbox', { name: /I trust the sender/ })).toBeNull()
    const installButton = screen.getByRole('button', { name: 'Install 2 skills' })
    expect((installButton as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('checkbox', { name: /alpha/ }))
    expect(screen.getByText('About this skill')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Install 1 skill' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('focuses the link first and programmatically names destination controls', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const skills = installApi(
      vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          name: 'private-skill',
          packageDigest: DIGEST,
          destinationIdentity: 'local:global',
          currentState: 'missing',
          providers: []
        }
      })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={onOpenChange} />)

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Orca skill link' }))
    // Why: the submit sits in the footer beside Close, so Enter in the field is
    // the keyboard path rather than tabbing past the back-out action.
    const footerButtons = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('data-slot') !== 'dialog-close')
    expect(footerButtons.map((button) => button.textContent?.trim())).toEqual([
      'Close',
      'Inspect skill'
    ])
    await user.type(
      screen.getByRole('textbox', { name: 'Orca skill link' }),
      'https://app.orca.dev/skills/share/share_1'
    )
    await user.keyboard('{Enter}')
    await screen.findByText('A private skill')
    expect(screen.getByRole('combobox', { name: 'Machine' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Destination' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('describes unavailable bearer links without asking recipients to sign in', async () => {
    const skills = installApi(vi.fn())
    skills.resolveShare.mockRejectedValue(new Error('skill_share_not_found'))
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)

    fireEvent.change(screen.getByLabelText('Orca skill link'), {
      target: { value: 'https://app.orca.dev/skills/share/share_1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect skill' }))

    await screen.findByText(
      'This share is unavailable. The link may be invalid, expired, or revoked.'
    )
    expect(screen.queryByText(/sign in|reconnect/i)).toBeNull()
  })

  it('installs a selected subset from a shared bundle', async () => {
    const skills = installApi(vi.fn())
    skills.resolveShare.mockResolvedValue({
      status: 'ok',
      value: { id: 'share_1', version: bundleVersion() }
    })
    Object.assign(skills, {
      previewBundleInstall: vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          packageId: 'pkg_1',
          versionId: 'ver_1',
          bundleDigest: 'c'.repeat(64),
          destinationIdentity: 'local:global',
          skills: [{ id: 'skill-beta', name: 'beta', digest: DIGEST, currentState: 'missing' }]
        }
      }),
      installBundleShare: vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          operationId: 'op_1',
          packageId: 'pkg_1',
          versionId: 'ver_1',
          bundleDigest: 'c'.repeat(64),
          status: 'complete',
          skills: [
            {
              skillId: 'skill-beta',
              name: 'beta',
              digest: DIGEST,
              status: 'installed',
              placements: []
            }
          ]
        }
      })
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills, preflight: detectionApi(['codex']) }
    })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill('alpha description')

    fireEvent.click(screen.getByRole('checkbox', { name: /alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Install 1 skill' }))

    await screen.findByText('Skills installed and verified.')
    expect(skills.installBundleShare).toHaveBeenCalledWith(
      expect.objectContaining({ selectedSkillIds: ['skill-beta'], versionId: 'ver_1' })
    )
  })

  it('keeps bundle conflicts local unless replacement is selected', async () => {
    const skills = installApi(vi.fn())
    skills.resolveShare.mockResolvedValue({
      status: 'ok',
      value: { id: 'share_1', version: bundleVersion() }
    })
    Object.assign(skills, {
      previewBundleInstall: vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          packageId: 'pkg_1',
          versionId: 'ver_1',
          bundleDigest: 'c'.repeat(64),
          destinationIdentity: 'local:global',
          skills: [
            { id: 'skill-alpha', name: 'alpha', digest: DIGEST, currentState: 'modified' },
            { id: 'skill-beta', name: 'beta', digest: DIGEST, currentState: 'missing' }
          ]
        }
      }),
      installBundleShare: vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          operationId: 'op_1',
          packageId: 'pkg_1',
          versionId: 'ver_1',
          bundleDigest: 'c'.repeat(64),
          status: 'partial',
          skills: []
        }
      })
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill('alpha description')

    fireEvent.click(screen.getByRole('button', { name: 'Install 2 skills' }))
    await screen.findByText('Local copies need a decision')
    expect(skills.installBundleShare).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Install 2 skills' }))
    await waitFor(() => expect(skills.installBundleShare).toHaveBeenCalledOnce())
    expect(skills.installBundleShare).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictDecisions: [{ skillId: 'skill-alpha', resolution: 'keep-local' }]
      })
    )
  })

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

  it('invalidates skill discovery after a verified install', async () => {
    const previewInstall = vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        name: 'private-skill',
        packageDigest: DIGEST,
        destinationIdentity: 'local:global',
        currentState: 'missing',
        providers: []
      }
    })
    const skills = installApi(previewInstall)
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    const changed = vi.fn()
    window.addEventListener('orca:installed-agent-skills-changed', changed)
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))

    await screen.findByText('Installed and verified.')
    expect(changed).toHaveBeenCalledOnce()
    window.removeEventListener('orca:installed-agent-skills-changed', changed)
  })

  it('cancels an active destination-owned install and renders the structured result', async () => {
    const previewInstall = vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        name: 'private-skill',
        packageDigest: DIGEST,
        destinationIdentity: 'local:global',
        currentState: 'missing',
        providers: []
      }
    })
    let settleInstall: ((value: unknown) => void) | undefined
    const skills = installApi(previewInstall)
    skills.installShare.mockImplementation(
      () => new Promise((resolve) => (settleInstall = resolve)) as never
    )
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel installation' }))

    await waitFor(() => expect(skills.cancelInstall).toHaveBeenCalledOnce())
    const operationId = skills.installShare.mock.calls[0]?.[0].operationId
    expect(skills.cancelInstall).toHaveBeenCalledWith({ operationId })
    settleInstall?.({
      status: 'ok',
      value: {
        operationId,
        status: 'cancelled',
        name: 'private-skill',
        packageDigest: DIGEST,
        placements: [],
        errorCategory: 'skill-install-cancelled',
        failure: { category: 'cancelled', code: 'skill-install-cancelled', retryable: true }
      }
    })
    await screen.findByText('Installation cancelled.')
    expect(screen.getByRole('button', { name: 'Retry install' })).toBeDefined()
  })

  it('announces install phases and allows incomplete provider coverage to retry', async () => {
    const previewInstall = vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        name: 'private-skill',
        packageDigest: DIGEST,
        destinationIdentity: 'local:global',
        currentState: 'missing',
        providers: []
      }
    })
    let settleInstall: ((value: unknown) => void) | undefined
    const skills = installApi(previewInstall)
    skills.installShare.mockImplementation(
      () => new Promise((resolve) => (settleInstall = resolve)) as never
    )
    Object.defineProperty(window, 'api', { configurable: true, value: { skills } })
    render(<SkillInstallDialog open onOpenChange={() => undefined} />)
    await inspectSkill()

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))
    await screen.findByText('Authorizing package access…')
    const operationId = skills.installShare.mock.calls[0]?.[0].operationId
    skills.emitInstallProgress({ operationId, phase: 'installing' })
    await screen.findByText('Downloading, verifying, and installing…')
    skills.emitInstallProgress({
      operationId,
      phase: 'installing',
      currentSkill: { id: 'private-skill', name: 'private-skill', index: 1, total: 1 }
    })
    expect((await screen.findByRole('status')).textContent).toBe(
      'Installing 1 of 1: private-skill…'
    )
    settleInstall?.({
      status: 'ok',
      value: {
        operationId,
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

    await screen.findByRole('button', { name: 'Retry install' })
  })
})
