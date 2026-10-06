// @vitest-environment happy-dom
// Crosses the real host writer, renderer notification bridge and settings-backed UI.
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../src/shared/constants'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import type { ProfileAgent } from '../../src/shared/agent-launch-profile'
import { createAgentProfileConnectionService } from '../../src/main/agent-profiles/runtime-composition'
import {
  updateSettings,
  type SettingsMutationOperations
} from '../../src/main/persistence/applying-settings/settings-update'
import { useAppStore } from '@/store'
import { registerSettingsAndSidebarIpcBridge } from '@/hooks/ipc-events/settings-sidebar-ipc-bridge'
import { resolveAgentProfileForWorkspace } from '@/lib/agent-profile-workspace-selection'
import { QuickLaunchAgentMenuItems } from '../../src/renderer/src/components/tab-bar/QuickLaunchButton'
import { AgentLaunchProfiles } from '../../src/renderer/src/components/settings/AgentLaunchProfiles'
const state = vi.hoisted(() => ({ root: '', launch: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../../src/main/codex-accounts/independent-profile-home', () => ({
  readManagedCodexProfileIdentity: () => ({
    email: 'new@example.test',
    providerAccountId: 'provider',
    workspaceAccountId: 'workspace'
  })
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude', 'codex'] })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: state.launch }))
vi.mock('../../src/renderer/src/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
let operations: SettingsMutationOperations
let service: ReturnType<typeof createAgentProfileConnectionService>
let cleanupBridge: (() => void)[]
const addClaude = vi.fn()
const addCodex = vi.fn()
const cancel = vi.fn(async () => true)
const remove = vi.fn()
const select = vi.fn()
let getSettings: ReturnType<typeof vi.fn>
function enroll(agent: ProfileAgent) {
  const common = {
    id: 'new',
    email: 'new@example.test',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  updateSettings(
    operations,
    agent === 'claude'
      ? {
          claudeManagedAccounts: [
            ...operations.state.settings.claudeManagedAccounts,
            {
              ...common,
              managedAuthPath: join(state.root, 'claude-accounts/new/auth'),
              authMethod: 'subscription-oauth'
            }
          ]
        }
      : {
          codexManagedAccounts: [
            ...operations.state.settings.codexManagedAccounts,
            { ...common, managedHomePath: join(state.root, 'codex-home') }
          ]
        }
  )
  return {
    accounts:
      agent === 'claude'
        ? operations.state.settings.claudeManagedAccounts
        : operations.state.settings.codexManagedAccounts
  }
}
function Surface({ agent }: { agent: ProfileAgent }) {
  const settings = useAppStore((s) => s.settings)
  return (
    settings && (
      <>
        <AgentLaunchProfiles agent={agent} settings={settings} />
        <nav aria-label="Launch menu">
          <QuickLaunchAgentMenuItems
            worktreeId="folder:local"
            groupId="test-group"
            onFocusTerminal={() => {}}
          />
        </nav>
      </>
    )
  )
}
function startForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
  fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Work' } })
}
async function saveForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save profile' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save profile' })).toBeNull())
}
function menu() {
  return within(screen.getByRole('navigation', { name: 'Launch menu' }))
}
function expectSelectionPreserved() {
  expect(operations.state.settings.activeClaudeManagedAccountId).toBe('previous')
  expect(operations.state.settings.activeCodexManagedAccountId).toBe('previous')
  expect(select).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.clearAllMocks()
  state.root = mkdtempSync(join(tmpdir(), 'profile-ui-sync-'))
  installFakeAppEnvironment({ getPath: () => state.root })
  const executable = join(state.root, 'cli')
  writeFileSync(executable, 'synthetic')
  chmodSync(executable, 0o700)
  const claudeHome = join(state.root, 'claude-accounts/new/auth')
  mkdirSync(claudeHome, { recursive: true })
  writeFileSync(join(claudeHome, '.orca-managed-claude-auth'), 'new')
  writeFileSync(
    join(claudeHome, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic' } })
  )
  writeFileSync(
    join(claudeHome, 'oauth-account.json'),
    JSON.stringify({ emailAddress: 'new@example.test' })
  )
  const codexHome = join(state.root, 'codex-home')
  mkdirSync(codexHome)
  const listeners = new Set<(updates: Partial<GlobalSettings>) => void>()
  operations = {
    state: getDefaultPersistedState(state.root),
    scheduleSave: vi.fn(),
    removeRetainedBlob: vi.fn(),
    bumpLocalWorktreeScanGeneration: vi.fn(),
    notifySettingsChanged: (updates) => listeners.forEach((listener) => listener(updates))
  }
  const previous = {
    id: 'previous',
    email: 'previous@example.test',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  operations.state.settings.claudeManagedAccounts = [
    {
      ...previous,
      managedAuthPath: join(state.root, 'previous-claude'),
      authMethod: 'subscription-oauth'
    }
  ]
  operations.state.settings.codexManagedAccounts = [
    { ...previous, managedHomePath: join(state.root, 'previous-codex') }
  ]
  operations.state.settings.activeClaudeManagedAccountId = 'previous'
  operations.state.settings.activeCodexManagedAccountId = 'previous'
  const hostStore = {
    getSettings: () => operations.state.settings,
    updateSettings: (
      updates: Partial<GlobalSettings>,
      options?: { notifyListeners?: boolean; originWebContentsId?: number }
    ) => updateSettings(operations, updates, options)
  }
  service = createAgentProfileConnectionService({
    store: hostStore,
    host: {
      hostId: 'local',
      platform: 'linux',
      isWsl: false,
      home: state.root,
      shell: '/bin/bash'
    },
    detectExecutable: async () => executable,
    claudeRuntimeAuth: { prepareForClaudeProfileLaunch: vi.fn() },
    codexRuntimeHome: {
      prepareForCodexProfileLaunch: vi.fn(),
      resolveCodexManagedAccountHomeForInactiveFetch: () => ({ kind: 'ready', homePath: codexHome })
    }
  })
  getSettings = vi.fn(async () => structuredClone(operations.state.settings))
  addClaude.mockImplementation(async () => enroll('claude'))
  addCodex.mockImplementation(async () => enroll('codex'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      platform: { get: () => ({ platform: 'linux', osRelease: 'test' }) },
      settings: {
        get: getSettings,
        onChanged: (listener: (updates: Partial<GlobalSettings>) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      agentProfiles: {
        preview: service.preview.bind(service),
        save: service.save.bind(service),
        unlink: service.unlink.bind(service)
      },
      runtimeEnvironments: { list: async () => [] },
      claudeAccounts: { add: addClaude, cancelPendingLogin: cancel, remove, select },
      codexAccounts: { add: addCodex, cancelPendingLogin: cancel, remove, select },
      ui: {
        onOpenSettings: () => () => {},
        onOpenFeatureTour: () => () => {},
        onStateChanged: () => () => {},
        onToggleLeftSidebar: () => () => {},
        onToggleRightSidebar: () => () => {},
        onToggleWorktreePalette: () => () => {},
        onToggleFloatingTerminal: () => () => {}
      }
    }
  })
  useAppStore.setState({
    settings: structuredClone(operations.state.settings),
    repos: [],
    projectGroups: [],
    worktreesByRepo: {},
    folderWorkspaces: [
      {
        id: 'local',
        name: 'Local',
        folderPath: state.root,
        projectGroupId: 'group',
        executionHostId: 'local',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  cleanupBridge = []
  registerSettingsAndSidebarIpcBridge(cleanupBridge)
})
afterEach(() => {
  cleanup()
  cleanupBridge.forEach((unsubscribe) => unsubscribe())
  rmSync(state.root, { recursive: true, force: true })
})
describe.each(['claude', 'codex'] as const)('%s settings synchronization', (agent) => {
  it('publishes save, rename and unlink into a mounted settings list and launch menu', async () => {
    render(<Surface agent={agent} />)
    startForm()
    fireEvent.click(screen.getByRole('radio', { name: 'Connect existing' }))
    fireEvent.change(screen.getByLabelText('Command or alias'), {
      target: {
        value: `${agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}=${state.root} ${agent}`
      }
    })
    await saveForm()
    await waitFor(() => expect(menu().getByRole('button', { name: /Work/ })).toBeTruthy())
    expect(screen.getByRole('region', { name: 'Agent profiles' }).textContent).toContain('Work')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Renamed' } })
    await saveForm()
    expect(menu().queryByRole('button', { name: /Work/ })).toBeNull()
    expect(menu().getByRole('button', { name: /Renamed/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(menu().queryByRole('button', { name: /Renamed/ })).toBeNull())
    expect(screen.getByRole('region', { name: 'Agent profiles' }).textContent).not.toContain(
      'Renamed'
    )
    expect(getSettings).not.toHaveBeenCalled()
  })
  it('refreshes enrolled accounts before immediate save and menu launch', async () => {
    render(<Surface agent={agent} />)
    startForm()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to another account' }))
    await waitFor(() =>
      expect(screen.getByRole('combobox').textContent).toContain('new@example.test')
    )
    await saveForm()
    const entry = await menu().findByRole('button', { name: /Work.*new@example.test/ })
    expect(entry.hasAttribute('disabled')).toBe(false)
    fireEvent.click(entry)
    const profile = operations.state.settings.agentLaunchProfiles![0]
    expect(state.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent, agentProfileId: profile.id })
    )
    expect(
      resolveAgentProfileForWorkspace(useAppStore.getState(), {
        agent,
        worktreeId: 'folder:local',
        agentProfileId: profile.id
      })
    ).toMatchObject({ binding: { kind: 'managed', accountId: 'new' } })
    expect(getSettings).toHaveBeenCalledOnce()
    expect(agent === 'claude' ? addClaude : addCodex).toHaveBeenCalledWith(
      agent === 'claude' ? { runtime: 'host' } : { runtime: 'host', activate: false }
    )
    expectSelectionPreserved()
  })
  it.each([
    { platform: 'win32', osRelease: 'test', hostId: 'local' },
    { platform: 'linux', osRelease: 'microsoft-standard-WSL2', hostId: 'local' },
    { platform: 'linux', osRelease: 'test', hostId: 'ssh:remote' },
    { platform: 'linux', osRelease: 'test', hostId: 'runtime:remote' }
  ] as const)('withholds profile actions on unsupported hosts: %j', async (host) => {
    const profile = await service.save({
      name: 'Work',
      connection: { agent, source: { kind: 'home', value: state.root } }
    })
    vi.spyOn(window.api.platform, 'get').mockReturnValue({
      ...window.api.platform.get(),
      platform: host.platform,
      osRelease: host.osRelease
    })
    useAppStore.setState((current) => ({
      folderWorkspaces: current.folderWorkspaces.map((folder) => ({
        ...folder,
        executionHostId: host.hostId
      }))
    }))
    render(<Surface agent={agent} />)
    expect(menu().queryByRole('button', { name: /Work/ })).toBeNull()
    expect(() =>
      resolveAgentProfileForWorkspace(useAppStore.getState(), {
        agent,
        worktreeId: 'folder:local',
        agentProfileId: profile.id
      })
    ).toThrow(/local macOS\/Linux/)
    expect(state.launch).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'retains successful enrollment across cancellation (login finishes first: %s)',
    async (loginFirst) => {
      let finish!: () => void
      ;(agent === 'claude' ? addClaude : addCodex).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return enroll(agent)
      })
      render(<Surface agent={agent} />)
      startForm()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to another account' }))
      if (loginFirst) {
        await act(async () => finish())
        await waitFor(() =>
          expect(screen.getByRole('combobox').textContent).toContain('new@example.test')
        )
      }
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      if (!loginFirst) {
        await act(async () => finish())
      }
      await waitFor(() => expect(getSettings).toHaveBeenCalledOnce())
      startForm()
      fireEvent.click(screen.getByRole('combobox'))
      const account = await screen.findByRole('option', { name: 'new@example.test' })
      expect(account).toBeTruthy()
      fireEvent.click(account)
      expect(operations.state.settings.agentLaunchProfiles ?? []).toEqual([])
      expect(menu().queryByRole('button', { name: /Work/ })).toBeNull()
      expect(cancel).toHaveBeenCalledTimes(loginFirst ? 0 : 1)
      expectSelectionPreserved()
    }
  )
})
