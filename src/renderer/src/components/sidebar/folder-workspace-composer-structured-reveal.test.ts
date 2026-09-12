// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  launchAgentSession: vi.fn(),
  planAgentSessionLaunch: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('@/lib/launch-agent-session', () => ({
  launchAgentSession: mocks.launchAgentSession
}))
vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mocks.planAgentSessionLaunch
}))

import { useAppStore } from '@/store'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

const projectGroup: ProjectGroup = {
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

const workspace: FolderWorkspace = {
  id: 'folder-workspace-1',
  projectGroupId: 'group-1',
  name: 'Structured folder',
  folderPath: '/repo/platform/structured-folder',
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

describe('folder workspace structured reveal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ settings: getDefaultSettings('/tmp') })
    mocks.planAgentSessionLaunch.mockReturnValue({
      route: 'structured-native-chat',
      launch: vi.fn()
    })
  })

  it.each([
    ['failure', { kind: 'failed', error: new Error('launch failed') }],
    ['cancellation', { kind: 'cancelled' }]
  ])('reveals before launch %s settles', async (_label, outcome) => {
    mocks.launchAgentSession.mockResolvedValue(outcome)

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Structured folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Start here',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => workspace),
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      agent: 'codex',
      providesInitialSurface: true,
      runtimeEnvironmentId: null
    })
    expect(mocks.activateAndRevealFolderWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launchAgentSession.mock.invocationCallOrder[0]
    )
  })
})
