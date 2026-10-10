// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSkillInstall } from '../../../../shared/skill-install-contract'
import type {
  SkillSharePreview,
  SkillShareProgress
} from '../../../../shared/skill-sharing-contract'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { SkillShareDialog } from './SkillShareDialog'

const skill: DiscoveredSkill = {
  id: 'home:private-skill',
  name: 'private-skill',
  description: 'Private skill',
  providers: ['codex'],
  sourceKind: 'home',
  sourceLabel: 'Home',
  rootPath: '/home/skills',
  directoryPath: '/home/skills/private-skill',
  skillFilePath: '/home/skills/private-skill/SKILL.md',
  installed: true,
  updatedAt: null
}

const preview: SkillSharePreview = {
  preparationId: '11111111-1111-4111-8111-111111111111',
  packageId: 'pkg_1',
  versionId: 'ver_2',
  name: 'private-skill',
  description: 'Private skill',
  packageDigest: 'a'.repeat(64),
  archiveSha256: 'b'.repeat(64),
  fileCount: 1,
  totalBytes: 128,
  compressedBytes: 96,
  scriptPaths: [],
  executablePaths: [],
  expiresAt: '2026-08-11T01:00:00.000Z'
}

const secondSkill: DiscoveredSkill = {
  ...skill,
  id: 'home:second-skill',
  name: 'second-skill',
  description: 'Second skill',
  directoryPath: '/home/skills/second-skill',
  skillFilePath: '/home/skills/second-skill/SKILL.md'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function managedInstall(destinationIdentity: string): ManagedSkillInstall {
  return {
    name: 'private-skill',
    packageId: 'pkg_1',
    versionId: 'ver_1',
    packageDigest: 'c'.repeat(64),
    scope: 'global',
    destinationIdentity,
    destination: { scope: 'global' },
    installedAt: '2026-08-11T00:00:00.000Z',
    state: 'unchanged'
  }
}

function setup(
  installs: ManagedSkillInstall[],
  organization = false,
  selectedSkills: DiscoveredSkill[] = [skill],
  previewOverrides: Partial<SkillSharePreview> = {},
  preparation?: Promise<SkillSharePreview>,
  authStatus: Promise<unknown> = Promise.resolve({
    cloud: { email: 'owner@example.com', ...(organization ? { activeOrgId: 'org_1' } : {}) }
  })
) {
  let progressListener: ((progress: SkillShareProgress) => void) | null = null
  const skills = {
    listManagedInstalls: vi.fn().mockResolvedValue({ status: 'ok', value: installs }),
    prepareShare: vi
      .fn()
      .mockReturnValue(preparation ?? Promise.resolve({ ...preview, ...previewOverrides })),
    publishShare: vi.fn(),
    cancelShare: vi.fn().mockResolvedValue(undefined),
    releaseShare: vi.fn().mockResolvedValue(undefined),
    onShareProgress: vi.fn((listener) => {
      progressListener = listener
      return () => undefined
    })
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      skills,
      orcaProfiles: {
        authStatus: vi.fn().mockReturnValue(authStatus),
        orgMembersList: vi.fn().mockResolvedValue({
          status: 'ok',
          roster: { members: [] }
        })
      }
    }
  })
  const view = render(
    <SkillShareDialog skills={selectedSkills} open onOpenChange={() => undefined} />
  )
  return {
    skills,
    emitProgress: (progress: SkillShareProgress) => progressListener?.(progress),
    unmount: view.unmount
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('SkillShareDialog', () => {
  it('releases a preparation that resolves after the dialog unmounts', async () => {
    const preparation = deferred<SkillSharePreview>()
    const { skills, unmount } = setup([], false, [skill], {}, preparation.promise)
    await waitFor(() => expect(skills.prepareShare).toHaveBeenCalledOnce())

    unmount()
    preparation.resolve(preview)

    await waitFor(() => expect(skills.releaseShare).toHaveBeenCalledWith(preview.preparationId))
  })

  it('releases a prepared archive when account inspection fails', async () => {
    const { skills } = setup(
      [],
      false,
      [skill],
      {},
      undefined,
      Promise.reject(new Error('auth unavailable'))
    )

    await waitFor(() => expect(skills.releaseShare).toHaveBeenCalledWith(preview.preparationId))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not prepare this skill for sharing.'
    )
  })

  it('releases a prepared archive when the dialog unmounts', async () => {
    const { skills, unmount } = setup([])
    await screen.findByRole('heading', { name: 'Share skill' })

    unmount()

    await waitFor(() => expect(skills.releaseShare).toHaveBeenCalledWith(preview.preparationId))
  })

  it('closes even when preparation cleanup fails', async () => {
    const onOpenChange = vi.fn()
    const { skills } = setup([])
    skills.releaseShare.mockRejectedValue(new Error('busy'))
    await screen.findByRole('heading', { name: 'Share skill' })

    cleanup()
    render(<SkillShareDialog skills={[skill]} open onOpenChange={onOpenChange} />)
    await screen.findByRole('heading', { name: 'Share skill' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('accepts multiline release notes up to the published limit', async () => {
    setup([], false, [skill, secondSkill])
    await screen.findByRole('heading', { name: 'Share skill bundle' })
    fireEvent.click(screen.getByRole('button', { name: 'Add release notes (optional)' }))
    const notes = screen.getByRole('textbox', { name: 'Release notes' }) as HTMLTextAreaElement
    const value = `Release summary\n${'x'.repeat(9_984)}`

    expect(notes.maxLength).toBe(10_000)
    fireEvent.change(notes, { target: { value } })
    expect(notes.value).toBe(value)
  })

  // Why: "what changed in this version?" has no answer on a first publish, so
  // the field only opens itself when there is a previous version to compare to.
  it('opens release notes only when publishing a new version', async () => {
    const { skills } = setup([managedInstall('global:local')])
    await screen.findByRole('heading', { name: 'Publish new skill version' })
    expect(screen.getByRole('textbox', { name: 'Release notes' })).toBeTruthy()
    expect(skills.prepareShare).toHaveBeenCalled()

    cleanup()
    setup([])
    await screen.findByRole('heading', { name: 'Share skill' })
    expect(screen.queryByRole('textbox', { name: 'Release notes' })).toBeNull()
  })

  it('names the files that can run instead of counting zeros', async () => {
    setup([], false, [skill], {
      scriptPaths: ['scripts/setup.sh'],
      executablePaths: ['bin/tool']
    })
    await screen.findByRole('heading', { name: 'Share skill' })
    expect(screen.getByText('1 script, 1 executable')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Review files that can run' }))
    expect(screen.getByText('scripts/setup.sh')).toBeTruthy()
    expect(screen.getByText('bin/tool')).toBeTruthy()
  })

  it('states that nothing in the package can run when no file can', async () => {
    setup([])
    await screen.findByRole('heading', { name: 'Share skill' })
    expect(screen.getByText('No scripts or executables')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review files that can run' })).toBeNull()
    expect(document.querySelector('.lucide-file-code-2')).toBeNull()
  })

  it('publishes a new immutable version for one exact managed-install match', async () => {
    const { skills } = setup([managedInstall('global:local')])

    await screen.findByRole('heading', { name: 'Publish new skill version' })
    expect(screen.getByRole('button', { name: 'Publish new version' })).toBeTruthy()
    expect(skills.prepareShare).toHaveBeenCalledWith({
      skillIds: [skill.id],
      bundleName: skill.name,
      packageId: 'pkg_1'
    })
  })

  it('does not choose a package when managed-install matching is ambiguous', async () => {
    const { skills } = setup([
      managedInstall('global:local'),
      managedInstall('global:other-environment')
    ])

    await screen.findByRole('heading', { name: 'Share skill' })
    await waitFor(() =>
      expect(skills.prepareShare).toHaveBeenCalledWith({
        skillIds: [skill.id],
        bundleName: skill.name
      })
    )
  })

  it('publishes a new immutable version for one exact managed bundle', async () => {
    const installs = [
      { ...managedInstall('global:local'), bundleDigest: 'd'.repeat(64) },
      {
        ...managedInstall('global:local'),
        name: secondSkill.name,
        bundleDigest: 'd'.repeat(64)
      }
    ]
    const { skills } = setup(installs, false, [skill, secondSkill])

    await screen.findByRole('heading', { name: 'Publish new skill bundle version' })
    expect(screen.getByRole('button', { name: 'Publish new version' })).toBeTruthy()
    expect(skills.prepareShare).toHaveBeenCalledWith({
      skillIds: [skill.id, secondSkill.id],
      bundleName: 'private-skill-and-1-more',
      packageId: 'pkg_1'
    })
  })

  it('shows bounded upload progress and supports cancellation', async () => {
    let rejectPublish: (error: Error) => void = () => undefined
    const { skills, emitProgress } = setup([], true)
    skills.publishShare.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectPublish = reject
      })
    )
    await screen.findByRole('heading', { name: 'Share skill' })

    fireEvent.click(screen.getByRole('button', { name: 'Publish skill' }))
    await screen.findByRole('button', { name: 'Cancel upload' })
    expect(
      screen.getByRole('progressbar', { name: 'Uploading…' }).getAttribute('aria-valuenow')
    ).toBe('0')
    emitProgress({
      preparationId: preview.preparationId,
      phase: 'uploading',
      bytesSent: 48,
      totalBytes: 96
    })
    await screen.findByText('50%')
    expect(
      screen.getByRole('progressbar', { name: 'Uploading…' }).getAttribute('aria-valuenow')
    ).toBe('50')
    emitProgress({
      preparationId: preview.preparationId,
      phase: 'finalizing',
      bytesSent: 96,
      totalBytes: 96
    })
    await screen.findByText('Verifying package…')
    expect(
      screen.getByRole('progressbar', { name: 'Verifying package…' }).getAttribute('aria-valuenow')
    ).toBe('100')
    emitProgress({
      preparationId: preview.preparationId,
      phase: 'publishing',
      bytesSent: 96,
      totalBytes: 96
    })
    await screen.findByText('Publishing link…')
    expect(screen.getByRole('progressbar', { name: 'Publishing link…' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }))
    await waitFor(() => expect(skills.cancelShare).toHaveBeenCalledWith(preview.preparationId))
    rejectPublish(new Error('aborted'))

    await screen.findByText('Upload cancelled. The prepared copy is still available to retry.')
  })
})
