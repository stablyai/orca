import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canShowWorkspaceFileBrowserAction,
  convertBrowserPageToWorkspaceDoc,
  getWorkspaceFilePreviewPlan,
  openFileInBrowserTab,
  openFilePreviewToSide
} from './file-preview'
import { TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE } from './workspace-file-browser-open-target'
import { localAndSshTwinRows } from './workspace-twin-rows.test-fixture'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'

function browserActionState(connectionId: string | null = null): never {
  return {
    repos: [{ id: 'repo-1', connectionId }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    getKnownWorktreeById: () => ({ id: 'wt-1', path: '/repo' })
  } as never
}

const mocks = vi.hoisted(() => ({
  browserAvailability: {
    state: 'enabled' as const,
    provider: 'local-client' as 'local-client' | 'paired-runtime'
  } as
    | { state: 'enabled'; provider: 'local-client' | 'paired-runtime' }
    | { state: 'hidden'; reason: string },
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(() => 'group-2'),
  setActiveBrowserTab: vi.fn(),
  setActiveBrowserPage: vi.fn(),
  setActiveWorktree: vi.fn(),
  activeWorktreeId: 'wt-1',
  focusGroup: vi.fn(),
  activateTab: vi.fn(),
  unifiedTabsByWorktree: {} as Record<string, unknown[]>,
  browserTabsByWorktree: {} as Record<string, unknown[]>,
  browserPagesByWorkspace: {} as Record<string, unknown[]>,
  convertBrowserPage: vi.fn(),
  environmentId: null as string | null,
  connectionId: null as string | null,
  twin: false,
  layoutByWorktree: {} as Record<string, unknown>,
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/client-creation-action-policy', () => ({
  getWorkspaceClientCreationActionPolicy: () => ({ 'managed-browser': mocks.browserAvailability })
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => mocks.environmentId
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      createBrowserTab: mocks.createBrowserTab,
      createEmptySplitGroup: mocks.createEmptySplitGroup,
      setActiveBrowserTab: mocks.setActiveBrowserTab,
      setActiveBrowserPage: mocks.setActiveBrowserPage,
      setActiveWorktree: mocks.setActiveWorktree,
      activeWorktreeId: mocks.activeWorktreeId,
      focusGroup: mocks.focusGroup,
      activateTab: mocks.activateTab,
      unifiedTabsByWorktree: mocks.unifiedTabsByWorktree,
      browserTabsByWorktree: mocks.browserTabsByWorktree,
      browserPagesByWorkspace: mocks.browserPagesByWorkspace,
      convertBrowserPage: mocks.convertBrowserPage,
      getKnownWorktreeById: () => ({ id: 'wt-1', path: '/srv/repo' }),
      groupsByWorktree: {},
      layoutByWorktree: mocks.layoutByWorktree,
      ...(mocks.twin
        ? localAndSshTwinRows('repo-1', 'wt-1')
        : {
            repos: [{ id: 'repo-1', connectionId: mocks.connectionId }],
            worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
          })
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.browserAvailability = { state: 'enabled', provider: 'local-client' }
  mocks.environmentId = null
  mocks.connectionId = null
  mocks.layoutByWorktree = {}
  mocks.browserTabsByWorktree = {}
  mocks.browserPagesByWorkspace = {}
  mocks.unifiedTabsByWorktree = {}
  mocks.activeWorktreeId = 'wt-1'
  mocks.twin = false
})

// Preview tabs identify documents rather than URLs; callers choose foreground opening versus side/background placement.
function docPreviewCall(filePath: string, extra: Record<string, unknown> = {}): unknown[] {
  return [
    'wt-1',
    'data:text/html,',
    {
      docLocation: { kind: 'workspace-doc', worktreeId: 'wt-1', filePath },
      title: filePath.slice(filePath.lastIndexOf('/') + 1),
      targetGroupId: undefined,
      browserRuntimeEnvironmentId: null,
      activate: false,
      ...extra
    }
  ]
}

function mockOpenDocument(filePath: string): void {
  const docLocation = { kind: 'workspace-doc' as const, worktreeId: 'wt-1', filePath }
  mocks.browserTabsByWorktree = { 'wt-1': [{ id: 'browser-9', docLocation }] }
  mocks.browserPagesByWorkspace = {
    'browser-9': [{ id: 'page-doc', worktreeId: 'wt-1', docLocation }]
  }
}

describe('openFileInBrowserTab', () => {
  it('reuses a document on an inactive page instead of creating a duplicate preview', () => {
    mocks.connectionId = 'ssh-1'
    mocks.browserTabsByWorktree = { 'wt-1': [{ id: 'browser-9', docLocation: null }] }
    mocks.browserPagesByWorkspace = {
      'browser-9': [
        { id: 'page-web', worktreeId: 'wt-1' },
        {
          id: 'page-doc',
          worktreeId: 'wt-1',
          docLocation: {
            kind: 'workspace-doc',
            worktreeId: 'wt-1',
            filePath: '/home/alice/report.html'
          }
        }
      ]
    }

    openFileInBrowserTab({ filePath: '/home/alice/report.html', worktreeId: 'wt-1' })

    expect(mocks.setActiveBrowserPage).toHaveBeenCalledWith('browser-9', 'page-doc')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })
  it('keeps a remote document preview in the requested group', () => {
    mocks.environmentId = 'env-1'
    openFileInBrowserTab({
      filePath: '/srv/repo/docs/report.html',
      worktreeId: 'wt-1',
      targetGroupId: 'group-2'
    })
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      ...docPreviewCall('/srv/repo/docs/report.html', { activate: true, targetGroupId: 'group-2' })
    )
  })
  it('opens a local file URL in the Orca browser with the filename as title', () => {
    openFileInBrowserTab({
      filePath: '/tmp/example file.html',
      worktreeId: 'wt-1'
    })

    expect(mocks.createBrowserTab).toHaveBeenCalledWith('wt-1', 'file:///tmp/example%20file.html', {
      title: 'example file.html',
      activate: true
    })
  })

  it('renders a paired-runtime file as a local doc preview instead of a runtime browser tab', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    const plan = openFileInBrowserTab({
      filePath: '/srv/repo/docs/example.html',
      worktreeId: 'wt-1'
    })

    expect(plan).toEqual({ status: 'doc-preview' })
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      ...docPreviewCall('/srv/repo/docs/example.html', { activate: true })
    )
  })

  // Reuse one document tab or duplicate tabs would mint separate grants for the same file.
  it('activates the tab a document is already open in', () => {
    mocks.connectionId = 'ssh-1'
    mockOpenDocument('/home/alice/report.html')

    openFileInBrowserTab({ filePath: '/home/alice/report.html', worktreeId: 'wt-1' })

    expect(mocks.setActiveBrowserTab).toHaveBeenCalledWith('browser-9')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  // Activate the unified tab, not browser state alone, or the terminal remains in front of the preview.
  it('brings an already-open document to the front of its group', () => {
    mocks.connectionId = 'ssh-1'
    mockOpenDocument('/home/alice/report.html')
    mocks.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'tab-terminal',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          entityId: 'term-1',
          groupId: 'group-1'
        },
        {
          id: 'tab-doc',
          worktreeId: 'wt-1',
          contentType: 'browser',
          entityId: 'browser-9',
          groupId: 'group-1'
        }
      ]
    }

    openFileInBrowserTab({ filePath: '/home/alice/report.html', worktreeId: 'wt-1' })

    expect(mocks.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mocks.activateTab).toHaveBeenCalledWith('tab-doc', { worktreeId: 'wt-1' })
    expect(mocks.setActiveBrowserTab).toHaveBeenCalledWith('browser-9')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  // Side previews must leave the reader working in the source, including when reusing a tab.
  it('leaves the reader in place when a side preview reuses an open document', () => {
    mocks.connectionId = 'ssh-1'
    mockOpenDocument('/home/alice/report.html')
    mocks.unifiedTabsByWorktree = {
      'wt-1': [{ id: 'tab-doc', contentType: 'browser', entityId: 'browser-9', groupId: 'group-1' }]
    }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/home/alice/report.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.activateTab).not.toHaveBeenCalled()
    expect(mocks.focusGroup).not.toHaveBeenCalled()
  })

  // Why: the split is part of the tab create, so reusing an open document must leave no empty group.
  it('creates no split when a side preview reuses an open document', () => {
    mocks.connectionId = 'ssh-1'
    mockOpenDocument('/home/alice/report.html')

    openFilePreviewToSide({
      language: 'html',
      filePath: '/home/alice/report.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.setActiveBrowserTab).toHaveBeenCalledWith('browser-9')
  })

  it('opens a second document in its own tab', () => {
    mocks.connectionId = 'ssh-1'
    mockOpenDocument('/home/alice/a.html')

    openFileInBrowserTab({ filePath: '/home/alice/b.html', worktreeId: 'wt-1' })

    expect(mocks.setActiveBrowserTab).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      ...docPreviewCall('/home/alice/b.html', { activate: true })
    )
  })

  it('renders an SSH file as a local doc preview', () => {
    mocks.connectionId = 'ssh-1'

    const plan = openFileInBrowserTab({
      filePath: '/home/alice/report.html',
      worktreeId: 'wt-1'
    })

    expect(plan).toEqual({ status: 'doc-preview' })
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      ...docPreviewCall('/home/alice/report.html', { activate: true })
    )
  })

  it('previews a paired runtime whose managed browser is unavailable', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'hidden', reason: 'streaming unavailable' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).toHaveBeenCalledOnce()
  })

  // Keep the background split unfocused; host snapshots interpret activated empty groups as terminals.
  it('creates paired-runtime side previews in an unfocused right-hand split', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      ...docPreviewCall('/srv/repo/example.html', {
        split: { sourceGroupId: 'group-1', splitDirection: 'right', activate: false }
      })
    )
  })

  it('creates local side previews in an activated right-hand split', () => {
    openFilePreviewToSide({
      language: 'html',
      filePath: '/tmp/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).toHaveBeenCalledWith('wt-1', 'file:///tmp/example.html', {
      title: 'example.html',
      split: { sourceGroupId: 'group-1', splitDirection: 'right', activate: true },
      activate: true
    })
  })

  it('rejects a local workspace whose managed browser is unavailable before creating a split', () => {
    mocks.browserAvailability = { state: 'hidden', reason: 'browser unavailable' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/tmp/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).toHaveBeenCalledWith('browser unavailable')
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  // Reject outside-worktree paired paths with a boundary message instead of a worktree-scoped files.read 404.
  it('names the worktree boundary for a paired document outside the workspace', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/tmp/agent-scratch/report.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Files outside the workspace can't be previewed on a paired server yet."
    )
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('keeps previewing an SSH document outside the worktree root', () => {
    mocks.connectionId = 'ssh-1'

    const plan = openFileInBrowserTab({
      filePath: '/tmp/agent-scratch/report.html',
      worktreeId: 'wt-1'
    })

    expect(plan).toEqual({ status: 'doc-preview' })
    expect(mocks.createBrowserTab).toHaveBeenCalledOnce()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('ignores languages that have no preview surface', () => {
    openFilePreviewToSide({
      language: 'typescript',
      filePath: '/tmp/example.ts',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })
})

describe('canShowWorkspaceFileBrowserAction', () => {
  it('permits paired runtimes regardless of managed-browser capability', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'hidden', reason: 'streaming unavailable' }
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)

    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)
  })

  // Keep the action visible so activation can explain the workspace boundary.
  it('keeps the action visible for a paired document outside the worktree', () => {
    mocks.environmentId = 'runtime-1'

    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/tmp/outside/report.html')
    ).toBe(true)
  })

  it('permits both local and SSH files', () => {
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState('ssh-1'), 'wt-1', '/repo/report.html')
    ).toBe(true)
  })

  it('hides the action while a file has no resolved owner', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const state = {
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath: '/workspace'
        }
      ],
      projectGroups: [{ id: 'group-1', parentGroupId: null }],
      repos: [
        {
          id: 'repo-local',
          path: '/workspace/local',
          projectGroupId: 'group-1'
        },
        {
          id: 'repo-ssh',
          path: '/workspace/remote',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {}
    } as never

    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/local/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/remote/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/unknown/report.html')
    ).toBe(false)
  })
})

describe('getWorkspaceFilePreviewPlan', () => {
  it('plans no local browser tab for a project two hosts publish', () => {
    mocks.twin = true
    expect(
      getWorkspaceFilePreviewPlan(useAppStore.getState(), 'wt-1', '/srv/repo/report.html')
    ).toEqual({
      status: 'unsupported',
      message: TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE,
      reason: 'no-channel'
    })
  })
})

// Address-bar conversion must also reuse the document’s existing grant/tab.
describe('convertBrowserPageToWorkspaceDoc', () => {
  const DOC_LOCATION = {
    kind: 'workspace-doc' as const,
    worktreeId: 'wt-1',
    filePath: '/home/alice/report.html'
  }

  // Inspect page docLocation: a mixed workspace’s mirror is null when its document page is inactive.
  it('activates the tab already showing the document, even as an inactive page', () => {
    mocks.browserTabsByWorktree = {
      'wt-1': [{ id: 'browser-9', docLocation: null }]
    }
    mocks.browserPagesByWorkspace = {
      'browser-9': [
        { id: 'page-web', worktreeId: 'wt-1' },
        { id: 'page-doc', worktreeId: 'wt-1', docLocation: DOC_LOCATION }
      ]
    }

    const outcome = convertBrowserPageToWorkspaceDoc('page-1', DOC_LOCATION)

    expect(outcome).toBe('activated-existing')
    expect(mocks.convertBrowserPage).not.toHaveBeenCalled()
    expect(mocks.setActiveBrowserTab).toHaveBeenCalledWith('browser-9')
    expect(mocks.setActiveBrowserPage).toHaveBeenCalledWith('browser-9', 'page-doc')
  })

  it('converts the page in place when no tab shows the document', () => {
    mocks.browserPagesByWorkspace = {
      'browser-1': [{ id: 'page-1', worktreeId: 'wt-1' }]
    }
    mocks.convertBrowserPage.mockReturnValue({ id: 'new-page' })

    const outcome = convertBrowserPageToWorkspaceDoc('page-1', DOC_LOCATION)

    expect(outcome).toBe('converted')
    expect(mocks.convertBrowserPage).toHaveBeenCalledWith(
      'page-1',
      { kind: 'workspace-doc', docLocation: DOC_LOCATION },
      undefined
    )
  })

  // Open another worktree’s document there; converting this row would leave its guest/links unable to take focus.
  it('opens a document from another worktree in that worktree instead of converting', () => {
    mocks.connectionId = 'ssh-1'
    mocks.activeWorktreeId = 'wt-other'
    mocks.browserPagesByWorkspace = {
      'browser-1': [{ id: 'page-1', worktreeId: 'wt-other' }]
    }

    const outcome = convertBrowserPageToWorkspaceDoc('page-1', DOC_LOCATION)

    expect(outcome).toBe('opened-in-owning-worktree')
    expect(mocks.convertBrowserPage).not.toHaveBeenCalled()
    // Activate the document’s worktree so opening cannot succeed invisibly.
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith('wt-1')
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      ...docPreviewCall(DOC_LOCATION.filePath, { activate: true })
    )
  })

  // History converts this tab in place; reusing another document tab would leave this tab’s history looping there.
  it.each(['history-return', 'history-advance'] as const)(
    'skips reuse on the %s leg and converts in place',
    (leg) => {
      mocks.browserTabsByWorktree = {
        'wt-1': [{ id: 'browser-9', docLocation: null }]
      }
      mocks.browserPagesByWorkspace = {
        'browser-9': [{ id: 'page-doc', worktreeId: 'wt-1', docLocation: DOC_LOCATION }],
        'browser-1': [{ id: 'page-1', worktreeId: 'wt-1' }]
      }
      mocks.convertBrowserPage.mockReturnValue({ id: 'new-page' })

      const outcome = convertBrowserPageToWorkspaceDoc('page-1', DOC_LOCATION, { leg })

      expect(outcome).toBe('converted')
      expect(mocks.setActiveBrowserTab).not.toHaveBeenCalled()
      expect(mocks.convertBrowserPage).toHaveBeenCalledWith(
        'page-1',
        { kind: 'workspace-doc', docLocation: DOC_LOCATION },
        { leg }
      )
    }
  )
})

// Web clients cannot host desktop preview webviews; hide the action instead of creating an unusable tab (#22618).
describe('document previews in a paired web client', () => {
  it('hides Open in Orca Browser and refuses with a reason instead of a silent no-op', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    try {
      mocks.environmentId = 'runtime-1'
      mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

      expect(
        canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
      ).toBe(false)
      const plan = openFileInBrowserTab({
        filePath: '/srv/repo/docs/example.html',
        worktreeId: 'wt-1'
      })
      expect(plan).toMatchObject({ status: 'unsupported', reason: 'no-channel' })
      expect(mocks.createBrowserTab).not.toHaveBeenCalled()

      mocks.browserPagesByWorkspace = { 'browser-1': [{ id: 'page-1', worktreeId: 'wt-1' }] }
      expect(
        convertBrowserPageToWorkspaceDoc('page-1', {
          kind: 'workspace-doc',
          worktreeId: 'wt-1',
          filePath: '/srv/repo/docs/example.html'
        })
      ).toBe('failed')
      expect(mocks.convertBrowserPage).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
