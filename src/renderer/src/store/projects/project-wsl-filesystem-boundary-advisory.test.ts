import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Project } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'

const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }))

vi.mock('sonner', () => ({ toast: { warning: warningMock } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars?.[name] ?? '')
}))

import { warnIfProjectCrossesWslFilesystemBoundary } from './project-wsl-filesystem-boundary-advisory'

const WSL_DEFAULT = {
  localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu-24.04' }
} as unknown as GlobalSettings

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return { id: 'repo-1', path: 'C:\\Users\\alice\\orca', ...overrides } as Repo
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return { id: 'project-1', sourceRepoIds: ['repo-1'], ...overrides } as Project
}

describe('warnIfProjectCrossesWslFilesystemBoundary', () => {
  beforeEach(() => {
    warningMock.mockReset()
  })

  it('warns and names the distro when a Windows-drive project runs WSL git', () => {
    warnIfProjectCrossesWslFilesystemBoundary(makeRepo(), [makeProject()], WSL_DEFAULT)

    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock.mock.calls[0]?.[1]?.description).toContain('Ubuntu-24.04')
  })

  // The project override is what actually routes git, so it must beat the global default here too.
  it('respects a project override that pins the project back to the Windows host', () => {
    warnIfProjectCrossesWslFilesystemBoundary(
      makeRepo(),
      [makeProject({ localWindowsRuntimePreference: { kind: 'windows-host' } })],
      WSL_DEFAULT
    )

    expect(warningMock).not.toHaveBeenCalled()
  })

  it('warns from a project override even when the global default is the Windows host', () => {
    warnIfProjectCrossesWslFilesystemBoundary(
      makeRepo(),
      [makeProject({ localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } })],
      { localWindowsRuntimeDefault: { kind: 'windows-host' } } as unknown as GlobalSettings
    )

    expect(warningMock.mock.calls[0]?.[1]?.description).toContain('Debian')
  })

  it('stays silent for a project already inside the distro', () => {
    warnIfProjectCrossesWslFilesystemBoundary(
      makeRepo({ path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\orca' }),
      [makeProject()],
      WSL_DEFAULT
    )

    expect(warningMock).not.toHaveBeenCalled()
  })

  // Why: the Windows runtime preference governs local projects only; an SSH path that happens to
  // look Windows-shaped is a different host's filesystem.
  it('stays silent for a repo on a remote execution host', () => {
    warnIfProjectCrossesWslFilesystemBoundary(
      makeRepo({ connectionId: 'ssh-1' }),
      [makeProject()],
      WSL_DEFAULT
    )

    expect(warningMock).not.toHaveBeenCalled()
  })

  it('stays silent when the WSL default has no distro to repair to', () => {
    warnIfProjectCrossesWslFilesystemBoundary(makeRepo(), [makeProject()], {
      localWindowsRuntimeDefault: { kind: 'wsl', distro: null }
    } as unknown as GlobalSettings)

    expect(warningMock).not.toHaveBeenCalled()
  })

  it('never throws when the advisory itself fails', () => {
    const repo = makeRepo()
    Object.defineProperty(repo, 'path', {
      get: () => {
        throw new Error('unreadable path')
      }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      warnIfProjectCrossesWslFilesystemBoundary(repo, [makeProject()], WSL_DEFAULT)
    ).not.toThrow()
    expect(warningMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
