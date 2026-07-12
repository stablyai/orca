// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Project, Repo } from '../../../../shared/types'
import { TooltipProvider } from '@/components/ui/tooltip'

const openSettingsPage = vi.fn()
const openSettingsTarget = vi.fn()

let mockRepos: Repo[] = []
let mockProjects: Project[] = []
let mockSettings: Partial<GlobalSettings> = { localWindowsRuntimeDefault: { kind: 'windows-host' } }
let mockPlatform: NodeJS.Platform = 'win32'
let mockCapabilities = {
  wslAvailable: true,
  wslDistros: ['Ubuntu'],
  pwshAvailable: true,
  gitBashAvailable: true,
  hostPlatform: 'win32' as NodeJS.Platform,
  isLoading: false
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeRepoId: null,
      activeWorktreeId: null,
      projects: mockProjects,
      repos: mockRepos,
      settings: mockSettings,
      worktreesByRepo: {},
      openSettingsPage,
      openSettingsTarget
    })
}))

vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: (enabled: boolean) =>
    enabled
      ? mockCapabilities
      : {
          wslAvailable: false,
          wslDistros: [],
          pwshAvailable: false,
          gitBashAvailable: false,
          hostPlatform: null,
          isLoading: false
        }
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => mockPlatform
}))

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: 'C:\\Users\\u\\app',
    displayName: 'app',
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  }
}

async function renderBadge(props: { repoId: string; repoPath: string }) {
  const { WslProjectBadge } = await import('./WslProjectBadge')
  return render(
    <TooltipProvider>
      <WslProjectBadge {...props} />
    </TooltipProvider>
  )
}

describe('WslProjectBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRepos = []
    mockProjects = []
    mockSettings = { localWindowsRuntimeDefault: { kind: 'windows-host' } }
    mockPlatform = 'win32'
    mockCapabilities = {
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32',
      isLoading: false
    }
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.resetModules()
  })

  it('shows WSL: <distro> for a healthy WSL project and the POSIX path in its tooltip', async () => {
    const wslRepo = repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\app' })
    mockRepos = [wslRepo]
    const { container } = await renderBadge({ repoId: wslRepo.id, repoPath: wslRepo.path })

    expect(screen.getByRole('button', { name: /Ubuntu/ }).textContent).toContain('WSL: Ubuntu')
    expect(container.innerHTML).not.toContain('wsl.localhost')
  })

  it('shows a repair affordance when the configured distro is missing', async () => {
    const wslRepo = repo({ path: '\\\\wsl.localhost\\Debian\\home\\u\\app' })
    mockRepos = [wslRepo]
    mockCapabilities = { ...mockCapabilities, wslDistros: ['Ubuntu'] }
    await renderBadge({ repoId: wslRepo.id, repoPath: wslRepo.path })

    const button = screen.getByRole('button')
    expect(button.textContent).toContain('WSL')
    expect(button.textContent).not.toContain('WSL: Debian')
  })

  it('renders nothing for a Windows-host project', async () => {
    const windowsRepo = repo()
    mockRepos = [windowsRepo]
    const { container } = await renderBadge({
      repoId: windowsRepo.id,
      repoPath: windowsRepo.path
    })

    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a non-local (SSH) repo', async () => {
    const sshRepo = repo({
      path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\app',
      connectionId: 'ssh-1'
    })
    mockRepos = [sshRepo]
    const { container } = await renderBadge({ repoId: sshRepo.id, repoPath: sshRepo.path })

    expect(container.innerHTML).toBe('')
  })

  it('renders nothing on a non-Windows host', async () => {
    mockPlatform = 'darwin'
    const wslRepo = repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\app' })
    mockRepos = [wslRepo]
    const { container } = await renderBadge({ repoId: wslRepo.id, repoPath: wslRepo.path })

    expect(container.innerHTML).toBe('')
  })

  it('navigates to the repo runtime settings section on click', async () => {
    const wslRepo = repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\app' })
    mockRepos = [wslRepo]
    const { getRepositoryRuntimeSectionId } =
      await import('@/components/settings/repository-settings-targets')
    await renderBadge({ repoId: wslRepo.id, repoPath: wslRepo.path })

    fireEvent.click(screen.getByRole('button'))

    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'repo',
      repoId: wslRepo.id,
      sectionId: getRepositoryRuntimeSectionId(wslRepo.id)
    })
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
  })
})
