// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'

const mocks = vi.hoisted(() => ({ activateAndRevealFolderWorkspace: vi.fn(), seedDraft: vi.fn() }))

vi.mock('@/lib/workspace/activation/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock(
  '@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    seedNativeChatLaunchDraftForAgentTab: mocks.seedDraft
  })
)
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { getDefaultSettings } from '../../../../../../shared/constants'
import { FolderWorkspaceCreate } from '../../../../../../shared/rpc-contract/folder-workspace-params'
import { FolderWorkspaceCreateArgs } from '../../../../../../main/ipc/repos/repo-ipc-arg-schemas'
import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft
} from '../../../../../../main/runtime/workspaces/startup/runtime-worktree-agent-startup'
import { prepareGroupFolderCreation } from '../../../../../../main/runtime/workspaces/creation/runtime-group-folder-setup'
import { useAppStore } from '@/store/index'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'
import { getFolderWorkspaceAgentLaunchFact } from './folder-workspace-agent-startup'

// The owning server’s OS determines agent command quoting.
describe('submitFolderWorkspaceCreate on an Orca server', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  })

  it('quotes quick-agent startup for POSIX when the folder group is a local WSL UNC path', async () => {
    const createFolderWorkspace = vi.fn(async () => ({ folderWorkspace: makeFolderWorkspace() }))
    const projectGroup = {
      ...makeProjectGroup(),
      parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\platform'
    }

    expect(getFolderWorkspaceAgentLaunchFact(useAppStore.getState(), projectGroup)).toMatchObject({
      platform: 'linux'
    })

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'WSL folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's POSIX startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({
          command: `claude 'Use Bob'"'"'s POSIX startup'`
        })
      })
    )
  })

  it('quotes quick-agent startup for the Windows OS the SSH relay reported', async () => {
    const createFolderWorkspace = vi.fn(async () => ({ folderWorkspace: makeFolderWorkspace() }))
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-windows',
      parentPath: 'C:\\Users\\alice\\platform'
    }
    useAppStore.setState({
      sshConnectionStates: new Map([
        [
          'ssh-windows',
          {
            targetId: 'ssh-windows',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            remotePlatform: 'win32'
          }
        ]
      ])
    })

    expect(getFolderWorkspaceAgentLaunchFact(useAppStore.getState(), projectGroup)).toMatchObject({
      platform: 'win32'
    })

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Remote Windows folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's Windows startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({
          command: "claude 'Use Bob''s Windows startup'"
        })
      })
    )
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  })

  it('quotes quick-agent startup for the Orca server that owns the folder group', async () => {
    const createFolderWorkspace = vi.fn(async () => ({ folderWorkspace: makeFolderWorkspace() }))
    const projectGroup = {
      ...makeProjectGroup(),
      executionHostId: 'runtime:win-box',
      parentPath: 'D:\\platform'
    }
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'win-box',
          {
            checkedAt: 1,
            status: {
              runtimeId: 'rt',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              hostPlatform: 'win32'
            }
          }
        ]
      ])
    })

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Server folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's server startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({ command: "claude 'Use Bob''s server startup'" })
      })
    )
  })

  it('refuses an agent launch on an Orca server that never reported its OS', async () => {
    const createFolderWorkspace = vi.fn(async () => ({ folderWorkspace: makeFolderWorkspace() }))
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })

    await expect(
      submitFolderWorkspaceCreate({
        projectGroup: { ...makeProjectGroup(), executionHostId: 'runtime:silent-box' },
        name: 'Server folder',
        lastAutoName: '',
        linkedWorkItem: null,
        note: '',
        quickAgent: 'claude',
        autoRenameBranchFromWork: false,
        agentCmdOverrides: {},
        createFolderWorkspace,
        onOpenChange: vi.fn()
      })
    ).rejects.toThrow('has not reported its operating system')
    expect(createFolderWorkspace).not.toHaveBeenCalled()
  })
})

it.each([
  { agent: 'codex', delivery: 'draft' },
  { agent: 'claude', delivery: null },
  { agent: 'autohand', delivery: 'auto-submit' }
] as const)(
  'preserves the actual paired $agent delivery through schemas and the host starter ($delivery)',
  async ({ agent, delivery }) => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'setup-tab' })
    mocks.seedDraft.mockClear()
    const projectGroup = { ...makeProjectGroup(), executionHostId: 'runtime:paired' as const }
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'paired',
          {
            checkedAt: 1,
            status: {
              runtimeId: 'rt',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              hostPlatform: 'linux'
            }
          }
        ]
      ])
    })
    const pasteDraft = vi.fn()
    const createTerminal = vi.fn(async (_selector: string, _options: unknown) => ({
      handle: 'agent',
      tabId: 'returned-agent-tab',
      ptyId: 'agent-pty',
      worktreeId: 'folder:folder-workspace-1',
      title: 'Agent'
    }))
    const sendFollowup = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentCmdOverrides: { [agent]: `custom-${agent} --color never` }
    }
    const environment = {
      repo: { path: '/tmp', connectionId: null },
      settings,
      getLaunchRuntime: () => ({
        platform: 'linux' as const,
        shell: 'posix' as const,
        launchRuntime: {
          platform: 'linux' as const,
          pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
        }
      })
    }
    const createFolderWorkspace = vi.fn(
      async (input: Parameters<typeof FolderWorkspaceCreate.parse>[0]) => {
        const parsed = FolderWorkspaceCreateArgs.parse(FolderWorkspaceCreate.parse(input))
        expect(parsed.startupCommand).toBeUndefined()
        expect(parsed.startupAgent).toBe(agent)
        if (delivery === 'auto-submit') {
          expect(parsed.startupPrompt).toBe('Inspect regular task')
          expect(parsed.startupDraft).toBeUndefined()
        } else {
          expect(parsed.startupDraft).toContain('https://linear.app/team/issue/STA-1')
          expect(parsed.startupPrompt).toBeUndefined()
        }
        return prepareGroupFolderCreation({
          input: parsed,
          group: { ...projectGroup, executionHostId: undefined },
          workspace: makeFolderWorkspace(),
          settings,
          startupBuilders: {
            agent: (agent, prompt, launchPreferences, inputs) =>
              buildWorktreeStartupForAgent({
                ...environment,
                agent,
                prompt,
                launchPreferences,
                ...inputs,
                toSessionOptions: () => undefined
              }),
            draft: (draft, requestedAgent) =>
              buildWorktreeStartupForDraft({ ...environment, draft, requestedAgent })
          },
          wait: async () => ({ exitCode: 0 }),
          ports: {
            canSpawn: true,
            createTerminal,
            pasteDraft,
            sendFollowup,
            provision: async () => ({ setupSpawned: false, setupTerminalHandle: null }),
            activate: vi.fn()
          }
        })
      }
    )
    await submitFolderWorkspaceCreate({
      projectGroup,
      setupSupported: true,
      setupApproval: { setupDecision: 'skip' },
      runtimeEnvironmentId: 'paired',
      name: 'Linked task',
      lastAutoName: '',
      linkedWorkItem:
        delivery === 'auto-submit'
          ? null
          : {
              provider: 'linear',
              type: 'issue',
              number: 1,
              title: 'Inspect task',
              url: 'https://linear.app/team/issue/STA-1'
            },
      note: delivery === 'auto-submit' ? 'Inspect regular task' : '',
      autoRenameBranchFromWork: false,
      quickAgent: agent,
      agentCmdOverrides: { [agent]: `custom-${agent} --color never` },
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })
    if (delivery === 'draft') {
      expect(pasteDraft).toHaveBeenCalledExactlyOnceWith('agent', {
        agent: 'codex',
        content: 'Linked Linear issue\nhttps://linear.app/team/issue/STA-1'
      })
      expect(sendFollowup).not.toHaveBeenCalled()
    } else if (delivery === 'auto-submit') {
      expect(pasteDraft).not.toHaveBeenCalled()
      expect(sendFollowup).toHaveBeenCalledExactlyOnceWith(
        'agent',
        { agent: 'autohand', prompt: 'Inspect regular task' },
        expect.objectContaining({ tabId: 'returned-agent-tab' })
      )
    } else {
      expect(pasteDraft).not.toHaveBeenCalled()
      expect(sendFollowup).not.toHaveBeenCalled()
    }
    if (delivery !== 'auto-submit') {
      expect(mocks.seedDraft).toHaveBeenCalledExactlyOnceWith({
        tabId: 'returned-agent-tab',
        agent,
        text: expect.stringContaining('https://linear.app/team/issue/STA-1')
      })
    } else {
      expect(mocks.seedDraft).not.toHaveBeenCalled()
    }
  }
)

it('applies the worktree semantic prompt and draft contract to IPC and RPC', () => {
  for (const schema of [FolderWorkspaceCreate, FolderWorkspaceCreateArgs]) {
    expect(schema.safeParse({ projectGroupId: 'group', startupPrompt: 'task' }).success).toBe(false)
    expect(
      schema.safeParse({ projectGroupId: 'group', startupAgent: 'codex', startupPrompt: 'task' })
        .success
    ).toBe(true)
    expect(
      schema.safeParse({
        projectGroupId: 'group',
        startupAgent: 'codex',
        startupDraft: 'linked task'
      }).success
    ).toBe(true)
    expect(
      schema.safeParse({ projectGroupId: 'group', startupCommand: 'custom --literal' }).success
    ).toBe(true)
  }
})

it('defers paired startup planning to the owning host when its OS has not been projected', async () => {
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  const createFolderWorkspace = vi.fn(async (input: unknown) => {
    const parsed = FolderWorkspaceCreateArgs.parse(FolderWorkspaceCreate.parse(input))
    expect(parsed.startupAgent).toBe('claude')
    expect(parsed.startupPrompt).toBe('Inspect on the host')
    return { folderWorkspace: makeFolderWorkspace() }
  })
  await submitFolderWorkspaceCreate({
    projectGroup: { ...makeProjectGroup(), executionHostId: 'runtime:unprojected' },
    setupSupported: true,
    setupApproval: { setupDecision: 'skip' },
    runtimeEnvironmentId: 'unprojected',
    name: 'Host task',
    lastAutoName: '',
    linkedWorkItem: null,
    note: 'Inspect on the host',
    quickAgent: 'claude',
    autoRenameBranchFromWork: false,
    agentCmdOverrides: {},
    createFolderWorkspace,
    onOpenChange: vi.fn()
  })
  expect(createFolderWorkspace).toHaveBeenCalledOnce()
})

it('creates a paired shell workspace without an agent prompt', async () => {
  const createFolderWorkspace = vi.fn(async (input: unknown) => {
    const parsed = FolderWorkspaceCreateArgs.parse(FolderWorkspaceCreate.parse(input))
    expect(parsed.startupAgent).toBeUndefined()
    expect(parsed.startupPrompt).toBeUndefined()
    return { folderWorkspace: makeFolderWorkspace() }
  })
  await submitFolderWorkspaceCreate({
    projectGroup: { ...makeProjectGroup(), executionHostId: 'runtime:paired-shell' },
    setupSupported: true,
    setupApproval: { setupDecision: 'skip' },
    runtimeEnvironmentId: 'paired-shell',
    name: 'Shell task',
    lastAutoName: '',
    linkedWorkItem: null,
    note: '',
    quickAgent: null,
    autoRenameBranchFromWork: false,
    agentCmdOverrides: {},
    createFolderWorkspace,
    onOpenChange: vi.fn()
  })
  expect(createFolderWorkspace).toHaveBeenCalledOnce()
})
