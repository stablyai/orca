// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'

const mocks = vi.hoisted(() => ({ activateAndRevealFolderWorkspace: vi.fn() }))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

import { useAppStore } from '@/store'
import {
  getFolderWorkspaceAgentLaunchFact,
  submitFolderWorkspaceCreate
} from './folder-workspace-composer-submit'

// The owning server’s OS determines agent command quoting.
describe('submitFolderWorkspaceCreate on an Orca server', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  })
  it('preserves SSH group ownership when creating and activating a folder workspace', async () => {
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    }
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace({ connectionId: 'ssh-1' }))
    const onOpenChange = vi.fn()

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'SSH workspace',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      isRemote: true,
      runtimeEnvironmentId: null,
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'SSH workspace',
      connectionId: 'ssh-1',
      linkedTask: null
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      agent: null,
      runtimeEnvironmentId: null
    })
  })

  it('quotes quick-agent startup for POSIX when the folder group is a local WSL UNC path', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
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
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
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
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
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
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
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
