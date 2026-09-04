// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  resolveAgentLaunchRoute: vi.fn(() => 'terminal-tui'),
  startStructuredCodexLaunch: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/lib/agent-launch-routing', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, resolveAgentLaunchRoute: mocks.resolveAgentLaunchRoute }
})

vi.mock('@/lib/structured-agent-session-launch', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, startStructuredCodexLaunch: mocks.startStructuredCodexLaunch }
})

import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

const PROJECT_GROUP: ProjectGroup = {
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

const WORKSPACE: FolderWorkspace = {
  id: 'folder-workspace-1',
  projectGroupId: 'group-1',
  name: 'Platform workspace',
  folderPath: '/repo/platform/platform-workspace',
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

describe('submitFolderWorkspaceCreate typed prompt', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    Object.assign(window, { api: { agentTrust: { markTrusted: vi.fn() } } })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.resolveAgentLaunchRoute.mockReset()
    mocks.resolveAgentLaunchRoute.mockReturnValue('terminal-tui')
    mocks.startStructuredCodexLaunch.mockReset()
    Reflect.deleteProperty(window, 'api')
  })

  it('submits the typed prompt at launch and leaves the note as workspace metadata', async () => {
    const createFolderWorkspace = vi.fn(async () => WORKSPACE)

    await submitFolderWorkspaceCreate({
      projectGroup: PROJECT_GROUP,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'card note',
      agentPrompt: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('Fix the flaky checkout flow')
    expect(startup?.command).not.toContain('card note')
    expect(startup?.draftPrompt).toBeUndefined()
    expect(createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ pendingFirstAgentMessageRename: true })
    )
  })

  // Why: the structured route bypasses the startup command, so it needs its own
  // prompt hand-off — a regression here silently sends the note instead.
  it('hands the typed prompt to a structured Codex launch', async () => {
    mocks.resolveAgentLaunchRoute.mockReturnValue('structured-native-chat')
    mocks.startStructuredCodexLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.resolve(),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: () => {},
      claimDefinitiveRefusalFallback: () => Promise.resolve()
    })

    await submitFolderWorkspaceCreate({
      projectGroup: PROJECT_GROUP,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'card note',
      agentPrompt: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => WORKSPACE),
      onOpenChange: vi.fn()
    })

    expect(mocks.startStructuredCodexLaunch).toHaveBeenCalledWith(expect.any(String), {
      prompt: 'Fix the flaky checkout flow'
    })
  })

  it('still launches the note when no prompt is typed', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: PROJECT_GROUP,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'card note',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => WORKSPACE),
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup?.command).toContain(
      'card note'
    )
  })
})
