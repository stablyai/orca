import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { buildAgentSessionForkPrompt } from '@/lib/agent-session-fork-context'

const UUID = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => {
  const connectionId: { value: string | null } = { value: null }
  return {
    launchAgentInNewTab: vi.fn(),
    activateAndRevealWorktree: vi.fn(),
    createWorktree: vi.fn(),
    toast: { error: vi.fn(), message: vi.fn(), success: vi.fn(), warning: vi.fn() },
    connectionId
  }
})

type StoreRepo = { id: string; kind?: 'git' | 'folder'; connectionId?: string | null }
const initialRepos: StoreRepo[] = []
const noDisabledAgents: string[] = []
const agentStatusByPaneKey: Record<string, { agentType?: string }> = {
  [`tab-1:${LEAF_ID}`]: { agentType: 'codex' }
}

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
  repos: initialRepos,
  settings: {
    localWindowsRuntimeDefault: { kind: 'windows-host' as const },
    disabledTuiAgents: noDisabledAgents
  },
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: 'C:\\repo', projectId: 'repo-1' }]
  },
  agentStatusByPaneKey,
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  getKnownWorktreeById: vi.fn(),
  createWorktree: mocks.createWorktree,
  ensureDetectedAgents: vi.fn(async () => ['claude', 'codex']),
  ensureRemoteDetectedAgents: vi.fn(async () => ['claude', 'codex']),
  ensureRuntimeDetectedAgents: vi.fn(async () => ['claude', 'codex'])
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude')
}))

function makePane(capturedText: string): ManagedPane {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fork reads only leafId, serializeAddon.serialize and terminal.focus, all present here.
  return {
    leafId: LEAF_ID,
    serializeAddon: { serialize: vi.fn(() => capturedText) },
    terminal: { focus: vi.fn() }
  } as unknown as ManagedPane
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectionId.value = null
  store.repos = [{ id: 'repo-1', kind: 'git' }]
  store.getKnownWorktreeById.mockReturnValue({
    id: 'wt-1',
    repoId: 'repo-1',
    displayName: 'auth-feature',
    branch: 'feature/auth'
  })
  mocks.createWorktree.mockResolvedValue({ worktree: { id: 'wt-fork', path: 'C:\\repo\\fork' } })
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'tab-new' },
    startupPlan: {},
    pasteDraftAfterLaunch: false
  })
  vi.stubGlobal('window', {
    api: {
      ui: { writeTerminalClipboardText: vi.fn(), writeClipboardText: vi.fn() },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

// Pins main's current launch behaviour as the convergence parity baseline (row 2): the exact arguments the session-continuation producer passes to launchAgentInNewTab.
describe('row 2 producer: launchAgentSessionContinuation args on main', () => {
  it.each([
    {
      agent: 'claude' as const,
      groupId: 'group-1',
      initialCwd: '/repo/worktree/packages/app',
      expected: {
        groupId: 'group-1',
        promptDelivery: 'draft',
        initialCwd: '/repo/worktree/packages/app'
      }
    },
    // A missing group or cwd is omitted, not passed as undefined; non-Claude agents paste after ready.
    {
      agent: 'codex' as const,
      groupId: null,
      initialCwd: null,
      expected: { promptDelivery: 'submit-after-ready' }
    }
  ])(
    '$agent passes exactly one launch request',
    async ({ agent, groupId, initialCwd, expected }) => {
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

      await expect(
        launchAgentSessionContinuation({
          agent,
          prompt: 'continue the unfinished task',
          worktreeId: 'wt-1',
          groupId,
          initialCwd,
          launchSource: 'terminal_context_menu'
        })
      ).resolves.toBe(true)

      expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
      expect(mocks.launchAgentInNewTab.mock.calls[0][0]).toStrictEqual({
        requestId: UUID,
        agent,
        worktreeId: 'wt-1',
        prompt: 'continue the unfinished task',
        launchSource: 'terminal_context_menu',
        onPromptDeliveryUnconfirmed: expect.any(Function),
        onPromptDelivered: expect.any(Function),
        ...expected
      })
    }
  )
})

// Pins main's current launch behaviour as the convergence parity baseline (row 2): the exact arguments the session-fork producer passes to launchAgentInNewTab.
describe('row 2 producer: startAgentSessionFork args on main', () => {
  it.each([
    // A native Windows fork leaves the platform to the launcher.
    { name: 'local Windows host', connectionId: null, launchPlatform: undefined },
    { name: 'SSH repo', connectionId: 'ssh-1', launchPlatform: 'linux' }
  ])('$name', async ({ connectionId, launchPlatform }) => {
    store.repos = [{ id: 'repo-1', kind: 'git', connectionId }]
    const { forkAgentSessionFromPane } =
      await import('@/components/terminal-pane/terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: compare OAuth options'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    const prompt = buildAgentSessionForkPrompt({
      capturedText: 'User: compare OAuth options',
      sourceLabel: `tab-1:${LEAF_ID}`,
      agentLabel: 'codex'
    })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
    const args = mocks.launchAgentInNewTab.mock.calls[0][0]
    // No requestId and no groupId: the plan carries the request, the fork opens a new workspace.
    expect(args).toStrictEqual({
      agent: 'codex',
      worktreeId: 'wt-fork',
      prompt,
      promptDelivery: 'draft',
      launchSource: 'terminal_context_menu',
      agentSessionLaunchPlan: expect.any(Object),
      beforeSurfaceOpen: expect.any(Function),
      ...(launchPlatform ? { launchPlatform } : {})
    })
    expect(args.agentSessionLaunchPlan).toStrictEqual({
      route: 'terminal-tui',
      requestId: UUID,
      agent: 'codex',
      worktreeId: 'wt-fork',
      prompt,
      promptDelivery: 'draft',
      begin: expect.any(Function),
      launch: expect.any(Function)
    })
  })
})
