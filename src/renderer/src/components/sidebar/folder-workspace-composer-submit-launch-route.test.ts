// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  startStructuredAgentLaunch: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})
vi.mock('@/lib/structured-agent-session-launch', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, startStructuredAgentLaunch: mocks.startStructuredAgentLaunch }
})

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

const structuredSettings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
} as GlobalSettings

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

function makeFolderWorkspace(): FolderWorkspace {
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
    updatedAt: 1
  }
}

describe('submitFolderWorkspaceCreate launch route', () => {
  afterEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
    Reflect.deleteProperty(window, 'api')
    vi.clearAllMocks()
  })

  // `null` still means "probed, genuinely unknown" and must degrade to the legacy route. The
  // cache and the bridge both hold the structured capability here, so only the handed-in value
  // can produce this outcome.
  it('degrades to the legacy route when the pre-resolved capabilities are unknown', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi
      .fn()
      .mockResolvedValue({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
    Object.assign(window, { api: { runtime: { getStatus } } })
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })

    const created = await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'hi',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      settings: structuredSettings,
      hostCapabilities: null,
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(created).toBe(true)
    expect(getStatus).not.toHaveBeenCalled()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({ startup: expect.objectContaining({ launchAgent: 'claude' }) })
    )
  })

  // A caller that owns a cancel gate resolves capabilities above it; re-probing here would
  // reopen the window between that gate and createFolderWorkspace.
  it('uses pre-resolved capabilities without probing again', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi.fn().mockResolvedValue({ capabilities: [] })
    Object.assign(window, { api: { runtime: { getStatus } } })
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.resolve({ sessionId: 'session-1' }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: () => {},
      claimDefinitiveRefusalFallback: () => Promise.resolve()
    })

    const created = await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'hi',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      settings: structuredSettings,
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(created).toBe(true)
    expect(getStatus).not.toHaveBeenCalled()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalled()
  })
})
