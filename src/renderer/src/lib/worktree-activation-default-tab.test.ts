import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Worktree } from '../../../shared/types'
import type { DefaultWorkspaceTab } from '../../../shared/default-workspace-tab'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { makeCreatedAgentWorktree } from '@/lib/worktree-activation-created-agent-test-state'

type AppStoreState = ReturnType<typeof useAppStore.getState>

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

// A worktree not created with an agent, so `buildCreatedAgentReopenStartup`
// stays out of the way and the default-workspace-tab setting takes effect.
function makePlainWorktree(): Worktree {
  return { ...makeCreatedAgentWorktree(), createdWithAgent: undefined }
}

function seedEmptyWorktree(
  worktree: Worktree,
  defaultWorkspaceTab: DefaultWorkspaceTab,
  overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}
): void {
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [worktree] },
    activeRepoId: 'repo-1',
    activeView: 'terminal',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab',
      defaultWorkspaceTab
    } as unknown as GlobalSettings,
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    ...overrides
  })
}

describe('activateAndRevealWorktree default workspace tab', () => {
  it('opens a plain terminal when the default is terminal', () => {
    const worktree = makePlainWorktree()
    seedEmptyWorktree(worktree, { kind: 'terminal' })

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const tab = state.tabsByWorktree[worktree.id]?.[0]

    expect(tab).toBeDefined()
    expect(result).toEqual({ primaryTabId: tab?.id })
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.browserTabsByWorktree[worktree.id] ?? []).toHaveLength(0)
  })

  it('seeds the first terminal with the configured default agent', () => {
    const worktree = makePlainWorktree()
    seedEmptyWorktree(worktree, { kind: 'agent', agent: 'codex' })

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const tab = state.tabsByWorktree[worktree.id]?.[0]

    expect(tab).toBeDefined()
    expect(result).toEqual({ primaryTabId: tab?.id })
    expect(state.pendingStartupByTabId[tab!.id]).toMatchObject({
      launchAgent: 'codex',
      telemetry: { agent_kind: 'codex', launch_source: 'sidebar', request_kind: 'new' }
    })
  })

  it('opens a browser surface when the default is browser', () => {
    const worktree = makePlainWorktree()
    const createBrowserTab = vi.fn(() => ({ id: 'browser-1' }))
    seedEmptyWorktree(
      worktree,
      { kind: 'browser' },
      {
        createBrowserTab: createBrowserTab as unknown as AppStoreState['createBrowserTab']
      }
    )

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()

    expect(createBrowserTab).toHaveBeenCalledWith(
      worktree.id,
      expect.any(String),
      expect.objectContaining({ activate: true })
    )
    expect(result).toEqual({ primaryTabId: 'browser-1' })
    // The browser surface replaces the terminal — no terminal tab is created.
    expect(state.tabsByWorktree[worktree.id]).toBeUndefined()
  })

  it('does not override an existing surface with a non-terminal default', () => {
    const worktree = makePlainWorktree()
    const createBrowserTab = vi.fn()
    seedEmptyWorktree(
      worktree,
      { kind: 'browser' },
      {
        createBrowserTab: createBrowserTab as unknown as AppStoreState['createBrowserTab'],
        tabsByWorktree: {
          [worktree.id]: [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreeId: worktree.id,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        unifiedTabsByWorktree: {
          [worktree.id]: [
            {
              id: 'tab-1',
              entityId: 'tab-1',
              groupId: 'group-1',
              worktreeId: worktree.id,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        groupsByWorktree: {
          [worktree.id]: [
            { id: 'group-1', worktreeId: worktree.id, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
          ]
        },
        activeGroupIdByWorktree: { [worktree.id]: 'group-1' }
      }
    )

    const result = activateAndRevealWorktree(worktree.id)

    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(result).toEqual({ primaryTabId: null })
  })

  it('resolves a terminal-shell default to a shell override on a local Windows host', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    const worktree = makePlainWorktree()
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    seedEmptyWorktree(
      worktree,
      { kind: 'terminal-shell', shell: 'cmd.exe' },
      {
        createTab: createTab as unknown as AppStoreState['createTab'],
        setActiveTab: vi.fn()
      }
    )

    activateAndRevealWorktree(worktree.id)

    expect(createTab).toHaveBeenCalledWith(
      worktree.id,
      undefined,
      'cmd.exe',
      expect.objectContaining({ pendingActivationSpawn: true })
    )
  })

  it('falls back to a plain terminal for a shell default on a non-Windows host', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)' })
    const worktree = makePlainWorktree()
    const createTab = vi.fn(() => ({ id: 'plain-tab' }))
    seedEmptyWorktree(
      worktree,
      { kind: 'terminal-shell', shell: 'cmd.exe' },
      {
        createTab: createTab as unknown as AppStoreState['createTab'],
        setActiveTab: vi.fn()
      }
    )

    activateAndRevealWorktree(worktree.id)

    // No shell override — a remote/non-Windows host gets a plain terminal.
    expect(createTab).toHaveBeenCalledWith(
      worktree.id,
      undefined,
      undefined,
      expect.objectContaining({ pendingActivationSpawn: true })
    )
  })

  it('lets an explicit startup take precedence over the default tab', () => {
    const worktree = makePlainWorktree()
    const createBrowserTab = vi.fn()
    seedEmptyWorktree(
      worktree,
      { kind: 'browser' },
      { createBrowserTab: createBrowserTab as unknown as AppStoreState['createBrowserTab'] }
    )

    const result = activateAndRevealWorktree(worktree.id, {
      startup: { command: 'echo precedence' }
    })
    const state = useAppStore.getState()
    const tab = state.tabsByWorktree[worktree.id]?.[0]

    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(tab).toBeDefined()
    expect(result).toEqual({ primaryTabId: tab?.id })
    expect(state.pendingStartupByTabId[tab!.id]).toMatchObject({ command: 'echo precedence' })
  })

  it('lets a created-with-agent reopen take precedence over the default tab', () => {
    // makeCreatedAgentWorktree seeds createdWithAgent: 'codex'.
    const worktree = makeCreatedAgentWorktree()
    const createBrowserTab = vi.fn()
    seedEmptyWorktree(
      worktree,
      { kind: 'browser' },
      { createBrowserTab: createBrowserTab as unknown as AppStoreState['createBrowserTab'] }
    )

    activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const tab = state.tabsByWorktree[worktree.id]?.[0]

    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(tab).toBeDefined()
    expect(state.pendingStartupByTabId[tab!.id]).toMatchObject({
      launchAgent: 'codex',
      telemetry: { request_kind: 'resume' }
    })
  })
})
