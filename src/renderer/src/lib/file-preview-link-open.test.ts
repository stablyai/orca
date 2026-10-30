import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import {
  TEST_REPO,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree
} from '@/store/slices/store-test-helpers'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  type BrowserLinkTestStore
} from './browser-link-open.test-fixture'
import { openFileInBrowserTab } from './file-preview'
import { captureLinkOpenIntent } from './link-open-intent'
import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant
} from './doc-preview-grants'
import type { BrowserOpenOutcome } from './browser-link-destination'
import { openResolvedHtmlFileInBrowser } from '@/components/terminal-pane/terminal-file-link-browser-open'
import {
  detectedListingFixture,
  terminalTabFixture
} from '@/components/native-chat/native-chat-workspace-test-fixtures'
import { openPlannedFileBrowserLink } from './file-preview-link-open'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), mint: vi.fn(), revoke: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
let store: BrowserLinkTestStore
const grants: string[] = []
beforeEach(() => {
  createStoreCascadesMockApi()
  Object.defineProperty(window.api, 'docPreview', {
    value: { mintGrant: mocks.mint, revokeGrant: mocks.revoke },
    configurable: true
  })
  mocks.mint.mockReset().mockImplementation(async (request: { browserPageId: string }) => ({
    grantId: `grant-${request.browserPageId}`,
    url: `orca-preview://grant-${request.browserPageId}/`
  }))
  mocks.revoke.mockReset().mockResolvedValue(undefined)
  store = createBrowserLinkTestStore()
  mocks.getState.mockImplementation(() => store.getState())
})
afterEach(() => {
  for (const id of grants.splice(0)) {
    releaseDocPreviewGrant(id)
  }
})

it.each([
  ['local', false],
  ['ssh:detected-owner', false],
  ['ssh:detected-owner', true]
] as const)(
  'opens a detected-only workspace preview beside its retained source on %s (selected twin: %s)',
  async (host, selectedTwin) => {
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        connectionId: host === 'local' ? null : 'detected-owner',
        executionHostId: host
      })),
      worktreesByRepo: {},
      detectedWorktreesByRepo: {
        repo1: detectedListingFixture([
          makeWorktree({ id: WORKSPACE, repoId: 'repo1', path: '/repo', hostId: host }),
          ...(selectedTwin
            ? [makeWorktree({ id: WORKSPACE, repoId: 'repo1', path: '/repo', hostId: 'local' })]
            : [])
        ])
      },
      activeWorktreeId: selectedTwin ? WORKSPACE : null,
      activeWorkspaceExecutionHostId: selectedTwin ? host : null,
      tabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
          terminalTabFixture(tab.entityId, WORKSPACE)
        )
      },
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
          ...tab,
          executionHostId: host
        }))
      }
    }))
    const outcome = await new Promise<BrowserOpenOutcome>((resolve) =>
      openFileInBrowserTab({
        filePath: '/repo/report.html',
        worktreeId: WORKSPACE,
        fileExecutionHostId: host,
        linkContext: { linkIntent: captureLinkOpenIntent(store.getState(), WORKSPACE, 'source') },
        onLinkOutcome: resolve
      })
    )
    expect(outcome).toMatchObject({
      status: 'opened',
      result: { worktreeId: WORKSPACE, executionHostId: host }
    })
    if (outcome.status !== 'opened') {
      throw new Error('Expected a detected-only workspace preview')
    }
    const page = store
      .getState()
      .browserPagesByWorkspace[outcome.result.browserWorkspaceId]?.find(
        (candidate) => candidate.id === outcome.result.browserPageId
      )
    expect(page).toMatchObject(
      host === 'local'
        ? { url: 'file:///repo/report.html' }
        : {
            docLocation: {
              kind: 'workspace-doc',
              worktreeId: WORKSPACE,
              filePath: '/repo/report.html'
            }
          }
    )
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe(outcome.result.groupId)
    expect(
      store.getState().groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId
    ).toBe('source')
  }
)

it('refuses a detected preview whose owner changed despite a retained active host selection', async () => {
  store.setState((state) => ({
    worktreesByRepo: {},
    detectedWorktreesByRepo: {
      repo1: detectedListingFixture(state.worktreesByRepo.repo1!)
    }
  }))
  const initial = store.getState()
  const linkIntent = captureLinkOpenIntent(initial, WORKSPACE, 'source')
  store.setState({
    detectedWorktreesByRepo: {
      repo1: detectedListingFixture([
        makeWorktree({
          id: WORKSPACE,
          repoId: 'repo1',
          path: '/repo',
          hostId: 'ssh:changed-owner'
        })
      ])
    }
  })
  const outcome = await openPlannedFileBrowserLink(
    initial,
    { worktreeId: WORKSPACE, filePath: '/repo/report.html', fileExecutionHostId: 'local' },
    { status: 'browser-tab', url: 'file:///repo/report.html', title: 'report.html' },
    { linkIntent },
    () => true
  )
  expect(outcome).toEqual({ status: 'refused' })
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
})

it('SSH document links reuse the source page and its grant without a website-browser capability', async () => {
  const host = 'ssh:ssh-test'
  store.setState((state) => ({
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'ssh-test',
      executionHostId: host
    })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({ ...worktree, hostId: host }))
    },
    activeWorkspaceExecutionHostId: host,
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        executionHostId: host
      }))
    },
    runtimeStatusByEnvironmentId: new Map()
  }))
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: WORKSPACE,
    filePath: '/repo/doc.html'
  }
  const original = store.getState().createBrowserTab(WORKSPACE, '', {
    targetGroupId: 'a',
    executionHostId: host,
    browserRuntimeEnvironmentId: null,
    docLocation,
    activate: false
  })
  let outcome: BrowserOpenOutcome | undefined
  let plan: ReturnType<typeof openFileInBrowserTab> | undefined
  await new Promise<void>((resolve) => {
    plan = openFileInBrowserTab({
      filePath: docLocation.filePath,
      worktreeId: WORKSPACE,
      linkContext: { linkIntent: captureLinkOpenIntent(store.getState(), WORKSPACE, 'source') },
      onLinkOutcome: (value) => {
        outcome = value
        resolve()
      }
    })
  })
  expect(plan?.status).toBe('doc-preview')
  expect(outcome).toMatchObject({
    status: 'opened',
    result: { groupId: 'a', executionHostId: host }
  })
  if (outcome?.status !== 'opened' || !original.activePageId) {
    throw new Error('Expected preview pages')
  }
  expect(outcome.result.browserPageId).toBe(original.activePageId)
  const location = buildDocPreviewGrantRequest(store.getState(), WORKSPACE, docLocation.filePath)
  if (!location) {
    throw new Error('Expected grant owner')
  }
  grants.push(original.activePageId)
  const first = await ensureDocPreviewGrant(original.activePageId, location)
  expect(await ensureDocPreviewGrant(outcome.result.browserPageId, location)).toBe(first)
  expect(mocks.mint).toHaveBeenCalledTimes(1)
  store.getState().closeBrowserTab(original.id)
  await Promise.resolve()
  await Promise.resolve()
  expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(first.grantId)
})

it('a folder workspace uses its own layout and activates its browser without Git metadata', async () => {
  const folder = 'folder:folder-1'
  store.setState({
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group',
        name: 'Folder',
        folderPath: '/folder',
        executionHostId: 'local',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    ],
    groupsByWorktree: {
      [folder]: ['left', 'right'].map((id) =>
        makeTabGroup({
          id,
          worktreeId: folder,
          activeTabId: id === 'left' ? 'chat' : 'terminal',
          tabOrder: [id === 'left' ? 'chat' : 'terminal']
        })
      )
    },
    unifiedTabsByWorktree: {
      [folder]: [
        makeUnifiedTab({
          id: 'chat',
          contentType: 'terminal',
          entityId: 'chat-terminal',
          worktreeId: folder,
          groupId: 'left',
          executionHostId: 'local'
        }),
        makeUnifiedTab({
          id: 'terminal',
          entityId: 'other-terminal',
          worktreeId: folder,
          groupId: 'right',
          executionHostId: 'local'
        })
      ]
    },
    tabsByWorktree: {
      [folder]: [
        terminalTabFixture('chat-terminal', folder),
        terminalTabFixture('other-terminal', folder)
      ]
    },
    activeGroupIdByWorktree: { [folder]: 'left' },
    layoutByWorktree: {
      [folder]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' }
      }
    },
    worktreesByRepo: {}
  })
  const outcome = vi.fn()
  await new Promise((resolve) =>
    openFileInBrowserTab({
      filePath: '/folder/report.html',
      worktreeId: folder,
      linkContext: { linkIntent: captureLinkOpenIntent(store.getState(), folder, 'chat') },
      onLinkOutcome: (result) => {
        outcome(result)
        resolve(result)
      }
    })
  )
  expect(outcome).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'opened',
      result: expect.objectContaining({ worktreeId: folder })
    })
  )
  expect(['left', 'right']).not.toContain(store.getState().activeGroupIdByWorktree[folder])
  expect(store.getState().layoutByWorktree[folder]).toMatchObject({
    first: { type: 'split', first: { groupId: 'left' } }
  })
})

it.each([false, true])(
  'refuses a replaced file owner for a captured preview (explicit: %s)',
  async (explicit) => {
    const linkIntent = captureLinkOpenIntent(store.getState(), WORKSPACE, 'source', {
      explicitSourceGroup: explicit
    })
    const host = 'ssh:changed-owner'
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        connectionId: 'changed-owner',
        executionHostId: host
      })),
      worktreesByRepo: {
        repo1: state.worktreesByRepo.repo1!.map((worktree) => ({ ...worktree, hostId: host }))
      },
      activeWorkspaceExecutionHostId: host
    }))
    const outcome = vi.fn()
    await new Promise((resolve) =>
      openFileInBrowserTab({
        filePath: '/repo/index.html',
        worktreeId: WORKSPACE,
        linkContext: { linkIntent },
        onLinkOutcome: (result) => {
          outcome(result)
          resolve(result)
        }
      })
    )
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: 'refused' })
    expect(store.getState().browserPagesByWorkspace).toEqual({})
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  }
)

it.each([true, false])(
  'validates the resolved file owner independently of a different source workspace (owner matches: %s)',
  async (ownerMatches) => {
    const destination = 'repo2::/other'
    const host = 'ssh:file-owner'
    const linkIntent = captureLinkOpenIntent(store.getState(), WORKSPACE, 'source')
    store.setState((state) => ({
      repos: [
        ...state.repos,
        { ...TEST_REPO, id: 'repo2', connectionId: 'file-owner', executionHostId: host }
      ],
      worktreesByRepo: {
        ...state.worktreesByRepo,
        repo2: [makeWorktree({ id: destination, repoId: 'repo2', path: '/other', hostId: host })]
      }
    }))
    const outcome = vi.fn()
    await new Promise((resolve) =>
      openFileInBrowserTab({
        filePath: '/other/report.html',
        worktreeId: destination,
        fileExecutionHostId: ownerMatches ? host : 'local',
        linkContext: { linkIntent },
        onLinkOutcome: (result) => {
          outcome(result)
          resolve(result)
        }
      })
    )
    if (!ownerMatches) {
      expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: 'refused' })
      expect(store.getState().browserPagesByWorkspace).toEqual({})
      expect(store.getState().activeWorktreeId).toBe(WORKSPACE)
      return
    }
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'opened',
        result: expect.objectContaining({ worktreeId: destination, executionHostId: host })
      })
    )
  }
)

it('keeps deliberate client-local HTML discovery from a remote source available', async () => {
  const host = 'ssh:remote-source'
  store.setState((state) => ({
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'remote-source',
      executionHostId: host
    })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({ ...worktree, hostId: host }))
    },
    activeWorkspaceExecutionHostId: host,
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        executionHostId: host
      }))
    }
  }))
  const outcome = await openResolvedHtmlFileInBrowser({
    filePath: '/tmp/client-report.html',
    worktreeId: WORKSPACE,
    clientLocal: true,
    linkContext: { linkIntent: captureLinkOpenIntent(store.getState(), WORKSPACE, 'source') }
  })
  expect(outcome).toMatchObject({ status: 'opened', result: { worktreeId: WORKSPACE } })
  if (outcome?.status !== 'opened') {
    throw new Error('Expected client-local preview')
  }
  expect(
    store.getState().browserPagesByWorkspace[outcome.result.browserWorkspaceId]?.[0]
  ).toMatchObject({
    url: 'file:///tmp/client-report.html',
    browserRuntimeEnvironmentId: null
  })
})
