// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAutomationRunActions,
  expandProjectFolderOnAutomationRun
} from './automation-run-actions'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationsPageActionContext } from './automations-page-action-context'
import type { AutomationDispatchContext } from './automation-row-action-dispatch'
import type { AutomationListRow } from './automation-list-row-identity'

const mocks = vi.hoisted(() => ({
  uncollapseSidebarGroups: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  dispatchAutomationRunNow: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    message: mocks.toastMessage
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./automation-row-action-dispatch', () => ({
  dispatchAutomationRunNow: (...args: unknown[]) => mocks.dispatchAutomationRunNow(...args)
}))

let mockStoreState: Record<string, unknown> = {}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'client',
    workspaceMode: 'existing',
    workspaceId: 'folder-ws-1',
    baseBranch: 'main',
    reuseSession: true,
    timezone: 'UTC',
    rrule: '',
    dtstart: Date.now(),
    enabled: true,
    nextRunAt: Date.now() + 10000,
    missedRunPolicy: 'run_once',
    missedRunGraceMinutes: 10,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Test run',
    scheduledFor: Date.now(),
    status: 'dispatched',
    trigger: 'manual',
    workspaceId: 'folder-ws-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/workspace/repo-1/${id}`,
    displayName: id,
    branch: 'feature',
    head: '123456',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('expandProjectFolderOnAutomationRun', () => {
  const rootGroup: ProjectGroup = {
    id: 'group-root',
    name: 'Root Group',
    parentPath: '/workspace',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 1,
    isCollapsed: true,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }

  const childGroup: ProjectGroup = {
    id: 'group-child',
    name: 'Child Group',
    parentPath: '/workspace/child',
    parentGroupId: 'group-root',
    createdFrom: 'manual',
    tabOrder: 2,
    isCollapsed: true,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }

  const folderWorkspace: FolderWorkspace = {
    id: 'folder-ws-1',
    projectGroupId: 'group-child',
    name: 'Test folder workspace',
    folderPath: '/workspace/child/ws1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreState = {
      settings: {
        expandProjectFolderOnAutomationRun: true
      },
      folderWorkspaces: [folderWorkspace],
      projectGroups: [rootGroup, childGroup],
      worktrees: [],
      repoMap: new Map<string, Repo>(),
      uncollapseSidebarGroups: mocks.uncollapseSidebarGroups
    }
  })

  it('uncollapses ancestor project groups when a run starts on a folder workspace (#20113)', () => {
    expandProjectFolderOnAutomationRun('folder-ws-1')

    expect(mocks.uncollapseSidebarGroups).toHaveBeenCalledWith([
      'project-group:group-root',
      'project-group:group-child'
    ])
  })

  it('uncollapses scoped folder keys (folder:id) as well (#20113)', () => {
    expandProjectFolderOnAutomationRun('folder:folder-ws-1')

    expect(mocks.uncollapseSidebarGroups).toHaveBeenCalledWith([
      'project-group:group-root',
      'project-group:group-child'
    ])
  })

  it('uncollapses project groups and repo key for git worktrees (#20113)', () => {
    const repo: Repo = {
      id: 'repo-1',
      name: 'Repo 1',
      path: '/workspace/repo-1',
      isBare: false,
      isArchived: false,
      sortOrder: 1,
      projectGroupId: 'group-child'
    }
    const worktree: Worktree = {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/workspace/repo-1/wt-1',
      displayName: 'Feature worktree',
      branch: 'feature',
      head: '123456',
      isBare: false,
      isMainWorktree: false,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 1
    }

    mockStoreState = {
      ...mockStoreState,
      worktrees: [worktree],
      repoMap: new Map([['repo-1', repo]]),
      groupBy: 'repo'
    }

    expandProjectFolderOnAutomationRun('wt-1')

    expect(mocks.uncollapseSidebarGroups).toHaveBeenCalledWith([
      'project-group:group-root',
      'project-group:group-child',
      'project:repo-1'
    ])
  })

  it('does not uncollapse if expandProjectFolderOnAutomationRun is false (#20113)', () => {
    mockStoreState = {
      ...mockStoreState,
      settings: {
        expandProjectFolderOnAutomationRun: false
      }
    }

    expandProjectFolderOnAutomationRun('folder-ws-1')

    expect(mocks.uncollapseSidebarGroups).not.toHaveBeenCalled()
  })

  it('does nothing if workspaceId is missing or empty (#20113)', () => {
    expandProjectFolderOnAutomationRun(null)
    expandProjectFolderOnAutomationRun(undefined)
    expandProjectFolderOnAutomationRun('')

    expect(mocks.uncollapseSidebarGroups).not.toHaveBeenCalled()
  })

  it('catches and warns if uncollapsing fails without throwing (#20113)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStoreState = {
      ...mockStoreState,
      uncollapseSidebarGroups: () => {
        throw new Error('store failure')
      }
    }

    expect(() => expandProjectFolderOnAutomationRun('folder-ws-1')).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[automations] failed to expand project folder'),
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })
})

describe('createAutomationRunActions integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dispatchAutomationRunNow.mockResolvedValue({ ok: true })
    mockStoreState = {
      settings: {
        expandProjectFolderOnAutomationRun: true
      },
      folderWorkspaces: [
        {
          id: 'folder-ws-1',
          projectGroupId: 'group-1',
          name: 'Workspace 1',
          folderPath: '/p',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      projectGroups: [
        {
          id: 'group-1',
          name: 'Group 1',
          parentPath: '/p',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 1,
          isCollapsed: true,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      worktrees: [],
      repoMap: new Map(),
      uncollapseSidebarGroups: mocks.uncollapseSidebarGroups,
      recordFeatureInteraction: mocks.recordFeatureInteraction
    }
  })

  it('triggers folder uncollapse when runNow dispatches successfully (#20113)', async () => {
    const automation = makeAutomation({ workspaceId: 'folder-ws-1' })
    const row: AutomationListRow = {
      key: 'row-1',
      automation,
      type: 'automation',
      isFirstGroupRow: true
    }

    const context = {
      store: {
        projectHostSetups: [],
        sshConnectionStates: new Map(),
        runtimeStatusByEnvironmentId: new Map(),
        repoForRow: () => ({
          id: 'repo-1',
          name: 'Repo 1',
          path: '/workspace/repo-1',
          isBare: false,
          isArchived: false,
          sortOrder: 1,
          projectGroupId: 'group-1'
        }),
        worktreeForRow: () => makeWorktree('folder-ws-1')
      },
      local: {
        rerunRunIdsInFlightRef: { current: new Set<string>() },
        setRerunRunIdsInFlight: vi.fn()
      },
      destination: {
        automationHostTargetFor: () => ({ kind: 'local' as const }),
        automationDispatchContext: {} as unknown as AutomationDispatchContext,
        reportOwnerAction: vi.fn(),
        invalidateRowHost: vi.fn()
      },
      sourceAvailability: {
        automationSourceHostAvailabilityByRowKey: new Map()
      },
      pageRefresh: {
        hydratePersistedUIState: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as AutomationsPageActionContext

    const actions = createAutomationRunActions(context)
    await actions.runNow(row)

    expect(mocks.uncollapseSidebarGroups).toHaveBeenCalledWith(['project-group:group-1'])
  })

  it('triggers folder uncollapse when rerunAutomationRun dispatches successfully (#20113)', async () => {
    const automation = makeAutomation({ workspaceId: 'folder-ws-1' })
    const run = makeRun({ workspaceId: 'folder-ws-1' })
    const row: AutomationListRow = {
      key: 'row-1',
      automation,
      type: 'automation',
      isFirstGroupRow: true
    }

    const context = {
      store: {
        projectHostSetups: [],
        sshConnectionStates: new Map(),
        runtimeStatusByEnvironmentId: new Map(),
        repoForRow: () => ({
          id: 'repo-1',
          name: 'Repo 1',
          path: '/workspace/repo-1',
          isBare: false,
          isArchived: false,
          sortOrder: 1,
          projectGroupId: 'group-1'
        }),
        worktreeForRow: () => makeWorktree('folder-ws-1')
      },
      local: {
        rerunRunIdsInFlightRef: { current: new Set<string>() },
        setRerunRunIdsInFlight: vi.fn()
      },
      destination: {
        automationHostTargetFor: () => ({ kind: 'local' as const }),
        automationDispatchContext: {} as unknown as AutomationDispatchContext,
        reportOwnerAction: vi.fn(),
        invalidateRowHost: vi.fn()
      },
      sourceAvailability: {
        automationSourceHostAvailabilityByRowKey: new Map()
      },
      pageRefresh: {
        hydratePersistedUIState: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as AutomationsPageActionContext

    const actions = createAutomationRunActions(context)
    await actions.rerunAutomationRun(row, run)

    expect(mocks.uncollapseSidebarGroups).toHaveBeenCalledWith(['project-group:group-1'])
  })
})
