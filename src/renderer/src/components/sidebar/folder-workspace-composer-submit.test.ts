// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))

import {
  getFolderWorkspaceAgentLaunchPlatform,
  submitFolderWorkspaceCreate
} from './folder-workspace-composer-submit'

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/repo/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'hi',
    folderPath: '/repo/platform/hi',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('submitFolderWorkspaceCreate', () => {
  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    vi.restoreAllMocks()
  })

  it('closes the composer after creation even when reveal fails', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.activateAndRevealFolderWorkspace.mockImplementation(() => {
      throw new Error('activation failed')
    })

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'hi',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'hi',
      connectionId: null,
      linkedTask: null
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to activate folder workspace after create:',
      expect.any(Error)
    )
  })

  it('marks a blank folder workspace for first-input rename when launching an agent with a note', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      agentArgs: '--model gpt-5.4',
      agentEnv: { ORCA_AGENT_PROFILE: 'review' },
      launchSource: 'new_workspace_composer',
      runtimeEnvironmentId: 'env-1',
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Platform workspace',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex',
      pendingFirstAgentMessageRename: true
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        runtimeEnvironmentId: 'env-1',
        startup: expect.objectContaining({
          command: expect.stringContaining('codex'),
          env: { ORCA_AGENT_PROFILE: 'review' },
          telemetry: expect.objectContaining({
            launch_source: 'new_workspace_composer'
          })
        })
      })
    )
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('--model')
    expect(startup?.command).toContain('gpt-5.4')
  })

  it('does not mark first-input rename when the folder workspace has an explicit name', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Checkout polish',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Checkout polish',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex'
    })
  })

  it('does not mark first-input rename when a linked work item owns the folder workspace name', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 42,
      title: 'Restore checkout polish',
      url: 'https://github.com/stablyai/orca/issues/42',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Use the issue context',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore checkout polish',
      connectionId: null,
      linkedTask: linkedWorkItem,
      createdWithAgent: 'codex'
    })
  })

  it('does not mark first-input rename without submitted first input', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '   ',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Platform workspace',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex'
    })
  })

  it('quotes quick-agent startup for POSIX when the folder group is a local WSL UNC path', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const projectGroup = {
      ...makeProjectGroup(),
      parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\platform'
    }

    expect(getFolderWorkspaceAgentLaunchPlatform(projectGroup)).toBe('linux')

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
          command: "claude 'Use Bob'\\''s POSIX startup'"
        })
      })
    )
  })

  it('quotes quick-agent startup for Windows when the remote folder group uses a Windows path', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-windows',
      parentPath: 'C:\\Users\\alice\\platform'
    }

    expect(getFolderWorkspaceAgentLaunchPlatform(projectGroup)).toBe('win32')

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
      runtimeEnvironmentId: null
    })
  })

  it('returns false when folder workspace creation fails without returning a workspace', async () => {
    const createFolderWorkspace = vi.fn(async () => null)
    const onOpenChange = vi.fn()

    await expect(
      submitFolderWorkspaceCreate({
        projectGroup: makeProjectGroup(),
        name: 'hi',
        lastAutoName: '',
        linkedWorkItem: null,
        note: '',
        quickAgent: null,
        autoRenameBranchFromWork: false,
        agentCmdOverrides: {},
        createFolderWorkspace,
        onOpenChange
      })
    ).resolves.toBe(false)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })
})
