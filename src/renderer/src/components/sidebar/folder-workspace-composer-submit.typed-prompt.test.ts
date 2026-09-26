// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type * as NewWorkspaceModule from '@/lib/new-workspace'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof NewWorkspaceModule>()
  return { ...actual, ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal }
})

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

describe('submitFolderWorkspaceCreate typed prompt', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    Object.assign(window, {
      api: { agentTrust: { markTrusted: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('auto-submits a typed prompt for a folder workspace without a linked item', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      typedPrompt: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      launchSource: 'new_workspace_composer',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ pendingFirstAgentMessageRename: true })
    )
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('Fix the flaky checkout flow')
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('auto-submits a typed prompt with linked context appended instead of drafting it', async () => {
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
      note: '',
      typedPrompt: 'Review the migration',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      launchSource: 'new_workspace_composer',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('Review the migration')
    expect(startup?.command).toContain(linkedWorkItem.url)
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })
})
