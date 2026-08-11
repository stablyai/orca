// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type * as NewWorkspaceModule from '@/lib/new-workspace'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn()
}))

// Why: importOriginal keeps the real resolveStartupLaunchDraftText, so the
// invariant test below exercises the shipped gate instead of a copy of it.
vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof NewWorkspaceModule>()
  return {
    ...actual,
    ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal
  }
})

import { useAppStore } from '@/store'
import { decideInitialAgentTabViewMode } from '@/lib/native-chat-initial-view-mode'
import { resolveStartupLaunchDraftText } from '@/lib/worktree-activation'
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
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    Object.assign(window, {
      api: {
        agentTrust: {
          markTrusted: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    Reflect.deleteProperty(window, 'api')
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
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
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

  it('creates a Jira folder workspace with its bound source context', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    const linkedTaskSourceContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'group-1',
      hostId: 'runtime:folder-env' as const,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      }
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      linkedTaskSourceContext,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'ORCA-123 Link Jira',
      connectionId: null,
      linkedTask: linkedWorkItem,
      linkedTaskSourceContext
    })
  })

  it('keeps linked Codex context out of submitted startup and pastes it as a draft', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 91,
      title: 'Restore linked quick-create',
      url: 'https://github.com/stablyai/orca/pull/91',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Review this before starting',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      launchSource: 'new_workspace_composer',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore linked quick-create',
      connectionId: null,
      linkedTask: linkedWorkItem,
      createdWithAgent: 'codex'
    })
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toBe('codex')
    expect(startup?.command).not.toContain(linkedWorkItem.url)
    expect(startup?.command).not.toContain('Review this before starting')
    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/platform/hi'
    })
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: folderWorkspaceKey('folder-workspace-1'),
      primaryTabId: 'tab-1',
      startup: expect.objectContaining({
        agent: 'codex',
        launchCommand: 'codex',
        followupPrompt: null,
        draftPrompt: `Review this before starting\n\n${linkedWorkItem.url}`
      })
    })
  })

  it('pre-marks remote linked Codex folder workspaces trusted before draft paste', async () => {
    const createFolderWorkspace = vi.fn(async () =>
      makeFolderWorkspace({
        connectionId: 'ssh-1',
        folderPath: '/home/alice/platform/Trust remote folder draft'
      })
    )
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 92,
      title: 'Trust remote folder draft',
      url: 'https://github.com/stablyai/orca/pull/92',
      repoId: 'repo-1'
    }
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      parentPath: '/home/alice/platform'
    }

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      isRemote: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/home/alice/platform/Trust remote folder draft',
      connectionId: 'ssh-1'
    })
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: folderWorkspaceKey('folder-workspace-1'),
        startup: expect.objectContaining({
          agent: 'codex',
          draftPrompt: linkedWorkItem.url
        })
      })
    )
  })

  it('delivers non-linked follow-up prompts for agents that need stdin after launch', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Aider followup',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the failing folder prompt flow',
      quickAgent: 'aider',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toBe('aider')
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: folderWorkspaceKey('folder-workspace-1'),
      primaryTabId: 'tab-1',
      startup: expect.objectContaining({
        agent: 'aider',
        launchCommand: 'aider',
        followupPrompt: 'Fix the failing folder prompt flow'
      })
    })
  })

  it('uses native draft launch for linked agents with prefill support', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'gitlab' as const,
      type: 'mr' as const,
      number: 17,
      title: 'Review folder workspace draft',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/17',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Check the migration path',
      quickAgent: 'claude',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('claude --prefill')
    expect(startup?.command).toContain('Check the migration path')
    expect(startup?.command).toContain(linkedWorkItem.url)
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('uses native prefill for link-only Linear folder workspace drafts', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      title: 'Ship Linear source drafts',
      url: 'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts',
      linearIdentifier: 'ENG-77',
      linkedContext: {
        provider: 'linear' as const,
        version: 1 as const,
        renderedText: [
          'Linear issue context snapshot',
          'Identifier: ENG-77',
          'Title: Ship Linear source drafts',
          'Description:',
          'Distinctive folder Linear body.'
        ].join('\n')
      }
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'User note stays above source',
      quickAgent: 'claude',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'ENG-77 Ship Linear source drafts',
      connectionId: null,
      linkedTask: {
        provider: 'linear',
        type: 'issue',
        number: 0,
        title: 'Ship Linear source drafts',
        url: 'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts',
        linearIdentifier: 'ENG-77'
      },
      createdWithAgent: 'claude'
    })
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('claude --prefill')
    expect(startup?.command).toContain('User note stays above source')
    expect(startup?.command).toContain('Linked Linear issue: ENG-77')
    expect(startup?.command).toContain(
      'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts'
    )
    expect(startup?.command).not.toContain('Distinctive folder Linear body.')
    expect(startup?.command).not.toContain('--- BEGIN LINKED WORK ITEM CONTEXT ---')
    expect(startup?.command).not.toContain('orca linear')
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('keeps explicit blank linked folder creates free of agent startup and draft paste', async () => {
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
      note: 'Keep this as metadata only',
      quickAgent: null,
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore checkout polish',
      connectionId: null,
      linkedTask: linkedWorkItem
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
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

describe('submitFolderWorkspaceCreate native-chat launch draft', () => {
  const ISSUE_URL = 'https://github.com/stablyai/orca/issues/42'
  const linkedIssue = {
    provider: 'github' as const,
    type: 'issue' as const,
    number: 42,
    title: 'Restore linked quick-create',
    url: ISSUE_URL,
    repoId: 'repo-1'
  }

  function seededDraftFor(tabId: string): { text: string } | undefined {
    return useAppStore.getState().nativeChatLaunchDraftByTabId[tabId]
  }

  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Object.assign(window, {
      api: { agentTrust: { markTrusted: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('mirrors a startup-paste draft into the chat composer', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(seededDraftFor('tab-1')?.text).toBe(ISSUE_URL)
  })

  it('mirrors an argv-prefill draft, which never lands in startupPlan.draftPrompt', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: '',
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    // The draft rides in on `--prefill`, so the plan carries no draftPrompt at
    // all — keying the mirror off it would silently drop this whole branch.
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.draftPrompt).toBeUndefined()
    expect(startup?.command).toContain(ISSUE_URL)
    expect(seededDraftFor('tab-1')?.text).toBe(ISSUE_URL)
  })

  it('mirrors a multi-line draft into chat', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: 'Reproduce on Windows first',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        startup: expect.objectContaining({
          draftPrompt: `Reproduce on Windows first\n\n${ISSUE_URL}`
        })
      })
    )
    expect(seededDraftFor('tab-1')?.text).toBe(`Reproduce on Windows first\n\n${ISSUE_URL}`)
  })

  it('does not mirror an unlinked note, which is submitted rather than drafted', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(seededDraftFor('tab-1')).toBeUndefined()
  })
})

describe('folder-workspace draft: seeded set == chat-opening set', () => {
  const ISSUE_URL = 'https://github.com/stablyai/orca/issues/42'
  const linkedIssue = {
    provider: 'github' as const,
    type: 'issue' as const,
    number: 42,
    title: 'Restore linked quick-create',
    url: ISSUE_URL,
    repoId: 'repo-1'
  }

  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Object.assign(window, {
      api: { agentTrust: { markTrusted: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  // Why: `claude` takes its draft on argv, so `startupPlan.draftPrompt` stays
  // undefined; `codex` gets a startup paste and sets it. Both must reach the
  // view-mode gate, and both must agree with what the composer actually holds.
  it.each([
    ['argv-prefill', 'claude' as const, '', true],
    ['argv-prefill multi-line', 'claude' as const, 'Reproduce on Windows first', true],
    ['startup-paste', 'codex' as const, '', true],
    ['startup-paste multi-line', 'codex' as const, 'Reproduce on Windows first', true]
  ])('%s', async (_label, quickAgent, note, expectMirrored) => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note,
      quickAgent,
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    const seeded = useAppStore.getState().nativeChatLaunchDraftByTabId['tab-1'] != null
    const draftText = resolveStartupLaunchDraftText(startup)
    const opensInChat =
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: quickAgent,
        ...(draftText != null
          ? { promptDelivery: 'draft' as const, launchDraftText: draftText }
          : {})
      }) === 'chat'

    // The draft always reaches the TUI, whichever way it is delivered.
    expect(`${startup?.command ?? ''}${startup?.draftPrompt ?? ''}`).toContain(ISSUE_URL)
    expect(seeded).toBe(expectMirrored)
    expect(opensInChat).toBe(expectMirrored)
  })
})
