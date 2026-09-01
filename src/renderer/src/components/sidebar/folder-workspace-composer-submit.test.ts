// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  assertRuntimeSupportsAgentLaunchIdentity: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/runtime/agent-launch-identity-negotiation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    assertRuntimeSupportsAgentLaunchIdentity: mocks.assertRuntimeSupportsAgentLaunchIdentity
  }
})

import { decideInitialAgentTabViewMode } from '@/lib/native-chat-initial-view-mode'
import { resolveStartupLaunchDraftText } from '@/lib/worktree-startup-payload'
import { useAppStore } from '@/store'
import { AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE } from '@/runtime/agent-launch-identity-negotiation'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

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
    vi.clearAllMocks()
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Object.assign(window, {
      api: {
        agentTrust: {
          markTrusted: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  afterEach(() => {
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
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
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to activate folder workspace after create:',
      expect.any(Error)
    )
  })

  it('uses an identity-only host launch and marks a submitted first prompt for rename', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      launchSource: 'new_workspace_composer',
      runtimeEnvironmentId: 'env-1',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Platform workspace',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex',
      pendingFirstAgentMessageRename: true
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: 'env-1',
      startup: {
        command: '',
        launchAgent: 'codex',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'codex' },
          prompt: 'Fix the flaky checkout flow',
          allowEmptyPromptLaunch: true
        },
        telemetry: {
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
    })
  })

  // A pre-identity host strips agentLaunch and opens a blank shell, losing the
  // note. Nothing may be created, and the composer must stay open to keep it.
  it('refuses before creating anything when the runtime cannot launch agents', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()
    mocks.assertRuntimeSupportsAgentLaunchIdentity.mockRejectedValueOnce(
      new Error(AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE)
    )

    await expect(
      submitFolderWorkspaceCreate({
        projectGroup: makeProjectGroup(),
        name: '',
        lastAutoName: '',
        linkedWorkItem: null,
        note: 'Fix the flaky checkout flow',
        quickAgent: 'codex',
        autoRenameBranchFromWork: true,
        runtimeEnvironmentId: 'env-1',
        createFolderWorkspace,
        onOpenChange
      })
    ).rejects.toThrow(AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE)

    expect(createFolderWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does not probe the runtime for an agent-less folder workspace', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Docs',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      runtimeEnvironmentId: 'env-1',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.assertRuntimeSupportsAgentLaunchIdentity).not.toHaveBeenCalled()
    expect(createFolderWorkspace).toHaveBeenCalled()
  })

  it.each([
    {
      label: 'an explicit workspace name',
      name: 'Checkout polish',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      expectedName: 'Checkout polish'
    },
    {
      label: 'linked work-item naming',
      name: '',
      linkedWorkItem: {
        provider: 'github' as const,
        type: 'issue' as const,
        number: 42,
        title: 'Restore checkout polish',
        url: 'https://github.com/stablyai/orca/issues/42',
        repoId: 'repo-1'
      },
      note: 'Use the issue context',
      expectedName: 'Restore checkout polish'
    },
    {
      label: 'an empty submitted prompt',
      name: '',
      linkedWorkItem: null,
      note: '   ',
      expectedName: 'Platform workspace'
    }
  ])('does not mark first-input rename for $label', async (input) => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: input.name,
      lastAutoName: '',
      linkedWorkItem: input.linkedWorkItem,
      note: input.note,
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith(
      expect.not.objectContaining({ pendingFirstAgentMessageRename: true })
    )
    expect(createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: input.expectedName, createdWithAgent: 'codex' })
    )
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

  it('launches linked context as a host-owned draft and mirrors it into native chat', async () => {
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 91,
      title: 'Restore linked quick-create',
      url: 'https://github.com/stablyai/orca/pull/91',
      repoId: 'repo-1'
    }
    const draft = `Review this before starting\n\n${linkedWorkItem.url}`

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Review this before starting',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup).toMatchObject({
      command: '',
      launchAgent: 'codex',
      launchDraftText: draft,
      agentLaunch: {
        selection: { kind: 'agent', agent: 'codex' },
        prompt: draft,
        promptDelivery: 'draft'
      }
    })
    expect(startup).not.toHaveProperty('draftPrompt')
    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/platform/hi'
    })
    expect(useAppStore.getState().nativeChatLaunchDraftByTabId['tab-1']?.text).toBe(draft)
  })

  it('pre-marks remote folder agents trusted on the owning SSH host', async () => {
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      parentPath: '/home/alice/platform'
    }

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Remote folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      createFolderWorkspace: vi.fn(async () =>
        makeFolderWorkspace({
          connectionId: 'ssh-1',
          folderPath: '/home/alice/platform/Remote folder'
        })
      ),
      onOpenChange: vi.fn()
    })

    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/home/alice/platform/Remote folder',
      connectionId: 'ssh-1'
    })
  })

  it.each([
    ['a local WSL path', { parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\platform' }],
    [
      'a remote Windows path',
      { connectionId: 'ssh-windows', parentPath: 'C:\\Users\\alice\\platform' }
    ]
  ])('leaves command and platform resolution to the host for %s', async (_label, overrides) => {
    await submitFolderWorkspaceCreate({
      projectGroup: { ...makeProjectGroup(), ...overrides },
      name: 'Host-owned launch',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup).toMatchObject({
      command: '',
      agentLaunch: {
        selection: { kind: 'agent', agent: 'claude' },
        prompt: "Use Bob's startup"
      }
    })
  })

  it('keeps explicit blank linked creates free of agent startup', async () => {
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
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
  })

  it('preserves SSH group ownership when creating and activating a folder workspace', async () => {
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    }
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace({ connectionId: 'ssh-1' }))

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'SSH workspace',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      runtimeEnvironmentId: null,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'SSH workspace',
      connectionId: 'ssh-1',
      linkedTask: null
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
  })

  it('returns false when folder workspace creation fails', async () => {
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
        createFolderWorkspace: vi.fn(async () => null),
        onOpenChange
      })
    ).resolves.toBe(false)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })

  it.each([
    ['claude', ''],
    ['claude', 'Reproduce on Windows first'],
    ['codex', ''],
    ['codex', 'Reproduce on Windows first']
  ] as const)(
    'keeps the %s linked draft mirror and initial view decision aligned',
    async (agent, note) => {
      const linkedWorkItem = {
        provider: 'github' as const,
        type: 'issue' as const,
        number: 42,
        title: 'Restore linked quick-create',
        url: 'https://github.com/stablyai/orca/issues/42',
        repoId: 'repo-1'
      }

      await submitFolderWorkspaceCreate({
        projectGroup: makeProjectGroup(),
        name: '',
        lastAutoName: '',
        linkedWorkItem,
        note,
        quickAgent: agent,
        autoRenameBranchFromWork: false,
        createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
        onOpenChange: vi.fn()
      })

      const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
      const draftText = resolveStartupLaunchDraftText(startup)
      const seeded = useAppStore.getState().nativeChatLaunchDraftByTabId['tab-1']?.text
      const viewMode = decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent,
        ...(draftText ? { promptDelivery: 'draft' as const, launchDraftText: draftText } : {})
      })

      expect(draftText).toContain(linkedWorkItem.url)
      expect(seeded).toBe(draftText)
      expect(viewMode).toBe('chat')
    }
  )
})
