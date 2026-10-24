// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { MobileEmulatorAgentControlRow } from '../settings/MobileEmulatorAgentControlRow'
import { TooltipProvider } from '../ui/tooltip'
import { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'
import { MobileEmulatorAgentSetupGuideSteps } from './MobileEmulatorAgentSetupGuideSteps'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  plan: vi.fn(),
  execute: vi.fn()
}))

vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({
    isLoading: false,
    wslAvailable: true,
    wslDistros: ['Ubuntu']
  })
}))
vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: mocks.discover,
  notifyInstalledAgentSkillsRefreshed: vi.fn()
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))
vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({ command }: { command: string }) => (
    <pre data-testid="wsl-terminal">{command}</pre>
  )
}))

function EmulatorSetup(): React.JSX.Element {
  const setup = useMobileEmulatorAgentSetupState()
  return <MobileEmulatorAgentSetupGuideSteps setup={setup} />
}

beforeEach(() => {
  Object.assign(window, { api: { platform: { get: () => ({ platform: 'win32' }) } } })
  useAppStore.setState({
    settings: getDefaultSettings('/tmp'),
    activeRepoId: null,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    endpointProjects: [],
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironmentCatalogSettled: true,
    runtimeEnvironments: []
  })
  mocks.plan.mockReset()
  mocks.plan.mockResolvedValue({ kind: 'unsupported', reason: 'connect-host' })
  mocks.execute.mockReset()
  mocks.discover.mockReset()
  mocks.discover.mockReturnValue({
    installed: false,
    loading: false,
    error: null,
    refresh: vi.fn(async () => false)
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

for (const surface of ['guide', 'settings'] as const) {
  describe(`mobile emulator ${surface} skill target`, () => {
    function renderSurface(): void {
      render(
        <TooltipProvider>
          {surface === 'guide' ? <EmulatorSetup /> : <MobileEmulatorAgentControlRow />}
        </TooltipProvider>
      )
    }

    it.each(['repo::/remote', 'folder:restored'])(
      'does not scan or install locally while %s ownership is unknown',
      (workspaceId) => {
        useAppStore.setState({
          activeRepoId: 'repo',
          activeWorktreeId: workspaceId,
          activeWorkspaceExecutionHostId: 'runtime:paired'
        })
        renderSurface()
        expect(mocks.discover).toHaveBeenCalledWith(
          'orca-cli',
          expect.objectContaining({ runtimeTarget: null })
        )
        expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true)
        expect(mocks.plan).not.toHaveBeenCalled()
      }
    )

    it('keeps an unserved SSH owner unsupported instead of using the local transport fallback', async () => {
      const worktree = makeWorktree({ id: 'repo::/remote', repoId: 'repo', hostId: 'ssh:box' })
      useAppStore.setState({
        activeRepoId: 'repo',
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'ssh:box',
        worktreesByRepo: { repo: [worktree] }
      })
      renderSurface()
      expect(mocks.discover).toHaveBeenCalledWith(
        'orca-cli',
        expect.objectContaining({ runtimeTarget: null })
      )
      expect(
        await screen.findByText('Connect to this SSH host to install its skills.')
      ).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
      expect(mocks.plan).toHaveBeenCalledWith(
        { kind: 'ssh', targetId: 'box' },
        { names: ['orca-cli'] }
      )
      expect(mocks.execute).not.toHaveBeenCalled()
    })

    it('uses a paired owner even when the transport resolver falls back to local', async () => {
      mocks.plan.mockResolvedValue({ kind: 'unsupported', reason: 'update-server' })
      const worktree = makeWorktree({
        id: 'repo::/remote',
        repoId: 'repo',
        hostId: 'runtime:paired'
      })
      useAppStore.setState({
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'runtime:paired',
        worktreesByRepo: { repo: [worktree] }
      })
      renderSurface()
      expect(mocks.discover).toHaveBeenCalledWith(
        'orca-cli',
        expect.objectContaining({ runtimeTarget: { kind: 'environment', environmentId: 'paired' } })
      )
      await screen.findByText('Update Orca on the server to install its skills.')
      expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
      expect(mocks.plan).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'paired' },
        { names: ['orca-cli'] }
      )
    })

    it('retains the repair gate when its selected runtime belongs to the active project', () => {
      const path = String.raw`\\wsl.localhost\Debian\home\alice\repo`
      const worktree = makeWorktree({ id: 'repo::/missing', repoId: 'repo', hostId: 'local', path })
      useAppStore.setState({
        activeRepoId: 'repo',
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'local',
        repos: [{ id: 'repo', path, displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }],
        worktreesByRepo: { repo: [worktree] }
      })
      renderSurface()
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true)
      expect(mocks.plan).not.toHaveBeenCalled()
    })

    it.each(['worktree', 'folder'])(
      'scans the WSL %s and opens its legacy npx terminal',
      async (kind) => {
        const path = String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
        const worktree = makeWorktree({ id: 'repo::/local', repoId: 'repo', hostId: 'local', path })
        useAppStore.setState({
          activeRepoId: 'repo',
          activeWorktreeId: worktree.id,
          activeWorkspaceExecutionHostId: 'local',
          repos: [{ id: 'repo', path, displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }],
          worktreesByRepo: { repo: [worktree] }
        })
        if (kind === 'folder') {
          useAppStore.setState({
            activeWorktreeId: 'folder:wsl',
            folderWorkspaces: [
              makeFolderWorkspace({
                id: 'wsl',
                folderPath: path,
                projectGroupId: 'group',
                executionHostId: 'local'
              })
            ],
            projectGroups: [
              {
                id: 'group',
                name: 'Group',
                parentPath: path,
                parentGroupId: null,
                createdFrom: 'manual',
                tabOrder: 0,
                isCollapsed: false,
                color: null,
                createdAt: 0,
                updatedAt: 0
              }
            ],
            repos: [
              {
                id: 'repo',
                path,
                displayName: 'Repo',
                badgeColor: 'blue',
                addedAt: 1,
                projectGroupId: 'group'
              }
            ]
          })
        }
        renderSurface()
        expect(mocks.discover).toHaveBeenCalledWith(
          'orca-cli',
          expect.objectContaining({
            runtimeTarget: { kind: 'local' },
            discoveryTarget: expect.objectContaining({ projectRuntime: expect.anything() })
          })
        )
        fireEvent.click(screen.getByRole('button', { name: 'Install' }))
        expect((await screen.findByTestId('wsl-terminal')).textContent).toContain(
          'npx skills@1.7.2 add'
        )
        expect(mocks.plan).not.toHaveBeenCalled()
        expect(mocks.execute).not.toHaveBeenCalled()
      }
    )
  })
}
