import { describe, expect, it } from 'vitest'
import type { Project, Repo } from '../../../../shared/types'
import { isRendererMissionEligibleRepo } from './mission-repo-eligibility'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: 'C:\\src\\repo-1',
    displayName: 'Repo 1',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    displayName: 'Project 1',
    badgeColor: '#000',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('isRendererMissionEligibleRepo', () => {
  it('rejects a Windows project that inherits the global WSL runtime', () => {
    expect(
      isRendererMissionEligibleRepo(makeRepo(), {
        projects: [makeProject()],
        settings: { localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } },
        appPlatform: 'win32'
      })
    ).toBe(false)
  })

  it('honors project runtime overrides ahead of the Windows global default', () => {
    expect(
      isRendererMissionEligibleRepo(makeRepo(), {
        projects: [makeProject({ localWindowsRuntimePreference: { kind: 'windows-host' } })],
        settings: { localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } },
        appPlatform: 'win32'
      })
    ).toBe(true)

    expect(
      isRendererMissionEligibleRepo(makeRepo(), {
        projects: [
          makeProject({ localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } })
        ],
        settings: { localWindowsRuntimeDefault: { kind: 'windows-host' } },
        appPlatform: 'win32'
      })
    ).toBe(false)
  })

  it('still rejects folder, SSH, runtime-hosted, and WSL-path repositories', () => {
    const context = { projects: [], settings: null, appPlatform: 'win32' as const }
    expect(isRendererMissionEligibleRepo(makeRepo({ kind: 'folder' }), context)).toBe(false)
    expect(isRendererMissionEligibleRepo(makeRepo({ connectionId: 'target-1' }), context)).toBe(
      false
    )
    expect(
      isRendererMissionEligibleRepo(makeRepo({ executionHostId: 'runtime:env-1' }), context)
    ).toBe(false)
    expect(
      isRendererMissionEligibleRepo(
        makeRepo({ path: '\\\\wsl.localhost\\Ubuntu\\src\\repo-1' }),
        context
      )
    ).toBe(false)
  })
})
