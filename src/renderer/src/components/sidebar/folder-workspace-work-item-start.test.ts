// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn(),
  startStructuredAgentLaunch: vi.fn(),
  toastError: vi.fn(),
  store: {
    activeRepoId: null,
    activeWorktreeId: null,
    projects: [],
    repos: [],
    settings: null,
    worktreesByRepo: {},
    seedNativeChatLaunchDraft: vi.fn(),
    updateFolderWorkspace: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.store }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal }
})

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

const linkedIssue = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 58,
  title: 'Canary issue',
  url: 'https://github.com/salvadorgu7/orca/issues/58',
  repoId: 'repo-1'
}

const strictSettings = {
  workItemStartPromptDelivery: 'submit-after-ready'
} as GlobalSettings

function projectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
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
    updatedAt: 1,
    ...overrides
  }
}

function folderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Canary issue',
    folderPath: '/repo/platform/canary-issue',
    linkedTask: linkedIssue,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function strictCreateArgs(
  targetGroup: ProjectGroup = projectGroup(),
  agent: 'codex' | 'claude' = 'codex'
) {
  return {
    projectGroup: targetGroup,
    name: '',
    lastAutoName: '',
    linkedWorkItem: linkedIssue,
    note: '',
    quickAgent: agent,
    autoRenameBranchFromWork: false,
    agentCmdOverrides: {},
    settings: strictSettings,
    createFolderWorkspace: vi.fn(async () => folderWorkspace()),
    onOpenChange: vi.fn()
  }
}

describe('Folder Workspace work-item start policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLocalRuntimeCapabilitiesForTests([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
    Object.assign(window, {
      api: { agentTrust: { markTrusted: vi.fn().mockResolvedValue(undefined) } }
    })
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'codex-session-1',
      launchResult: Promise.resolve({ sessionId: 'codex-session-1', fence: 1 }),
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn()
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  it.each(['codex', 'claude'] as const)(
    'creates one folder workspace and one strict %s session with one delivery',
    async (agent) => {
      const args = strictCreateArgs(projectGroup(), agent)

      await expect(submitFolderWorkspaceCreate(args)).resolves.toBe(true)

      expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
      expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledOnce()
      expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
        'folder-workspace-1',
        expect.objectContaining({ providesInitialSurface: true, runtimeEnvironmentId: null })
      )
      expect(mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]).not.toHaveProperty(
        'startup'
      )
      expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
      expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith(
        folderWorkspaceKey('folder-workspace-1'),
        agent,
        {
          prompt: linkedIssue.url,
          promptDelivery: 'submit-after-ready',
          launchOrigin: 'work-item-start'
        }
      )
      expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['SSH', projectGroup({ connectionId: 'ssh-1', parentPath: '/home/alice/platform' })],
    ['WSL', projectGroup({ parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\platform' })]
  ])('fails closed before creating a %s folder workspace', async (_label, targetGroup) => {
    const args = strictCreateArgs(targetGroup)

    await expect(submitFolderWorkspaceCreate(args)).rejects.toThrow(
      'No workspace, terminal, or prompt was started.'
    )

    expect(args.createFolderWorkspace).not.toHaveBeenCalled()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('fails closed before creating a paired-runtime folder workspace', async () => {
    const args = { ...strictCreateArgs(), runtimeEnvironmentId: 'environment-1' }

    await expect(submitFolderWorkspaceCreate(args)).rejects.toThrow(
      'No workspace, terminal, or prompt was started.'
    )

    expect(args.createFolderWorkspace).not.toHaveBeenCalled()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('keeps an explicit draft policy on the terminal-backed draft path', async () => {
    const args = {
      ...strictCreateArgs(),
      settings: { ...strictSettings, workItemStartPromptDelivery: 'draft' as const }
    }

    await expect(submitFolderWorkspaceCreate(args)).resolves.toBe(true)

    expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({ draftPrompt: linkedIssue.url })
      })
    )
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledOnce()
  })

  it('does not start a terminal writer after a strict structured launch failure', async () => {
    const refusalFallback = vi.fn()
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'codex-session-1',
      launchResult: Promise.reject(new Error('structured launch unavailable')),
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: refusalFallback
    })
    const args = strictCreateArgs()

    await expect(submitFolderWorkspaceCreate(args)).resolves.toBe(true)

    expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(refusalFallback).not.toHaveBeenCalled()
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]).not.toHaveProperty('startup')
  })

  it('preserves the only session when prompt delivery remains unknown', async () => {
    const releaseCallerAfterUnknownOutcome = vi.fn()
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'codex-session-1',
      launchResult: Promise.resolve({ sessionId: 'codex-session-1', fence: 1 }),
      promptDeliveryResult: Promise.resolve({
        delivered: false,
        failureNotified: false,
        deliveryUnknown: true
      }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome,
      claimDefinitiveRefusalFallback: vi.fn()
    })
    const args = strictCreateArgs()

    await expect(submitFolderWorkspaceCreate(args)).resolves.toBe(true)

    expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(releaseCallerAfterUnknownOutcome).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('releases an unknown launch caller without making creation retryable', async () => {
    const releaseCallerAfterUnknownOutcome = vi.fn(() => true)
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'codex-session-1',
      launchResult: Promise.reject(new Error('agent launch visibility unknown')),
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: true }),
      isVisibilityUnknown: () => true,
      releaseCallerAfterUnknownOutcome,
      claimDefinitiveRefusalFallback: vi.fn()
    })
    const args = strictCreateArgs()

    await expect(submitFolderWorkspaceCreate(args)).resolves.toBe(true)

    expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(releaseCallerAfterUnknownOutcome).toHaveBeenCalledOnce()
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('reports a definitive prompt failure without making creation retryable', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'codex-session-1',
      launchResult: Promise.resolve({ sessionId: 'codex-session-1', fence: 1 }),
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn()
    })
    const args = strictCreateArgs()

    await expect(submitFolderWorkspaceCreate(args)).resolves.toBe(true)

    expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The structured agent session did not accept the work item prompt. Orca did not retry or start another writer.'
    )
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })
})
