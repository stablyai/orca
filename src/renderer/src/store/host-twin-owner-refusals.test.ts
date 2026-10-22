/**
 * Callers that used to read a twin's owner as "no paired server", and so acted on this app's copy,
 * now refuse it; one host's row still routes to that host.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UNRESOLVED_OWNER_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  createHostTwinFixture,
  TWIN_RUNTIME_ENV,
  type HostTwinFixture,
  type HostTwinKind
} from './host-twin.test-fixture'
import { makeWorktree } from './slices/store-test-helpers'
import { makeFolderWorkspace } from './slices/worktrees-slice-test-fixtures'

const appStore = vi.hoisted((): { current: HostTwinFixture['store'] | null } => ({
  current: null
}))

// Why: the drag source reads the app singleton; route it to this test's store.
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!appStore.current) {
        throw new Error('no twin fixture store bound')
      }
      return appStore.current.getState()
    }
  }
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const { resolveNativeChatAttachmentHost } =
  await import('@/components/native-chat/native-chat-attachment-upload')
const { getFileExplorerOperationOwnerFromState } =
  await import('@/components/right-sidebar/file-explorer-operation-owner')
const { writeWorkspaceFileDragSourceForWorkspace } =
  await import('@/lib/workspace-file-drag-source')
const { readWorkspaceFileDragSource } = await import('@/lib/workspace-file-drag')
const { resolveNativeChatSkillDiscoveryContext, selectNativeChatSkillStateInputs } =
  await import('@/components/native-chat/native-chat-skill-discovery-context')
const { mirroredRuntimeEnvironmentIdForWorkspace } =
  await import('@/runtime/web-session-tabs-sync/mirrored-workspace-owner')
const { resolveStructuredAgentSessionOwner } =
  await import('@/runtime/structured-agent-session-owner')

const RUNTIME_HOST: ExecutionHostId = `runtime:${TWIN_RUNTIME_ENV}`

function bind(fixture: HostTwinFixture): HostTwinFixture {
  appStore.current = fixture.store
  return fixture
}

/** The `local+runtime` fixture with only the paired server's copy left. */
function runtimeOnly(): HostTwinFixture {
  const fixture = bind(createHostTwinFixture('local+runtime'))
  const state = fixture.store.getState()
  fixture.store.setState({
    repos: state.repos.filter((repo) => repo.executionHostId === RUNTIME_HOST),
    worktreesByRepo: {
      [fixture.projectId]: [
        makeWorktree({
          id: fixture.workspaceKey,
          repoId: fixture.projectId,
          path: '/work/twin',
          hostId: RUNTIME_HOST
        })
      ]
    }
  })
  return fixture
}

function runtimeOnlyFolder(): HostTwinFixture {
  const fixture = bind(createHostTwinFixture('folder local+ssh'))
  fixture.store.setState({
    projectGroups: [],
    folderWorkspaces: [
      makeFolderWorkspace({
        id: fixture.projectId,
        projectGroupId: 'twin-group',
        folderPath: '/work/twin',
        executionHostId: RUNTIME_HOST
      })
    ]
  })
  return fixture
}

function dragSource(workspaceKey: string): ReturnType<typeof readWorkspaceFileDragSource> {
  const payload = new Map<string, string>()
  writeWorkspaceFileDragSourceForWorkspace(
    { setData: (type, value) => payload.set(type, value) },
    workspaceKey
  )
  return readWorkspaceFileDragSource({ getData: (type) => payload.get(type) ?? '' })
}

beforeEach(() => {
  appStore.current = null
})

describe.each<HostTwinKind>(['local+runtime', 'local+ssh'])('%s twin', (kind) => {
  it('uploads a chat attachment to neither host', () => {
    const { store, workspaceKey } = bind(createHostTwinFixture(kind))
    expect(resolveNativeChatAttachmentHost(store.getState(), workspaceKey)).toBeNull()
  })

  it('does not reopen a closed terminal as a local shell', () => {
    const { store, workspaceKey } = bind(createHostTwinFixture(kind))
    store.setState({ recentlyClosedTerminalTabsByWorktree: { [workspaceKey]: [{}] } })
    const tabsBefore = store.getState().tabsByWorktree[workspaceKey]

    expect(store.getState().reopenClosedTerminalTab(workspaceKey)).toBe(false)
    expect(store.getState().tabsByWorktree[workspaceKey]).toBe(tabsBefore)
  })

  it('names no source host for a file drag', () => {
    const { workspaceKey } = bind(createHostTwinFixture(kind))
    expect(dragSource(workspaceKey)).toBeNull()
  })
})

describe('chat skill discovery', () => {
  function skillContext(
    fixture: HostTwinFixture
  ): ReturnType<typeof resolveNativeChatSkillDiscoveryContext> {
    const { store, workspaceKey, local } = fixture
    store.setState({
      tabsByWorktree: {
        [workspaceKey]: [
          { ...store.getState().tabsByWorktree[workspaceKey][0], startupCwd: '/work/twin' }
        ]
      }
    })
    return resolveNativeChatSkillDiscoveryContext(
      selectNativeChatSkillStateInputs(store.getState()),
      local.terminalTabId
    )
  }

  it('waits for a host pick on a twin', () => {
    expect(skillContext(bind(createHostTwinFixture('local+runtime')))).toBeNull()
  })

  it('scans the copy the user picked', () => {
    const fixture = bind(createHostTwinFixture('local+runtime'))
    fixture.store.setState({
      activeWorktreeId: fixture.workspaceKey,
      activeWorkspaceExecutionHostId: 'local'
    })
    expect(skillContext(fixture)).toMatchObject({ runtimeTarget: { kind: 'local' } })
  })
})

describe('session mirroring', () => {
  it("mirrors a twin's server once the user picks that copy", () => {
    const { store, workspaceKey } = bind(createHostTwinFixture('local+runtime'))
    expect(mirroredRuntimeEnvironmentIdForWorkspace(store.getState(), workspaceKey)).toBeNull()
    store.setState({ activeWorktreeId: workspaceKey, activeWorkspaceExecutionHostId: RUNTIME_HOST })
    expect(mirroredRuntimeEnvironmentIdForWorkspace(store.getState(), workspaceKey)).toBe(
      TWIN_RUNTIME_ENV
    )
  })

  it("mirrors a single server's workspace", () => {
    const { store, workspaceKey } = runtimeOnly()
    expect(mirroredRuntimeEnvironmentIdForWorkspace(store.getState(), workspaceKey)).toBe(
      TWIN_RUNTIME_ENV
    )
  })
})

describe('one paired server owns the workspace', () => {
  it('uploads a chat attachment to that server', () => {
    const { store, workspaceKey } = runtimeOnly()
    expect(resolveNativeChatAttachmentHost(store.getState(), workspaceKey)).toBe(RUNTIME_HOST)
  })

  it('leaves a closed terminal to the server session', () => {
    const { store, workspaceKey } = runtimeOnly()
    store.setState({ recentlyClosedTerminalTabsByWorktree: { [workspaceKey]: [{}] } })
    expect(store.getState().reopenClosedTerminalTab(workspaceKey)).toBe(false)
  })

  it('names that server as the drag source', () => {
    const { workspaceKey } = runtimeOnly()
    expect(dragSource(workspaceKey)).toEqual({
      executionHostId: RUNTIME_HOST,
      workspaceId: workspaceKey
    })
  })

  it('routes a folder file operation to that server', () => {
    const { store } = runtimeOnlyFolder()
    expect(
      getFileExplorerOperationOwnerFromState(store.getState(), folderWorkspaceKey('twin-folder'))
    ).toMatchObject({ kind: 'runtime', environmentId: TWIN_RUNTIME_ENV })
  })
})

describe('folder workspace twin', () => {
  it.each<HostTwinKind>(['folder local+ssh', 'folder group local+ssh'])(
    '%s leaves a file operation unresolved',
    (kind) => {
      const { store, workspaceKey } = bind(createHostTwinFixture(kind))
      expect(getFileExplorerOperationOwnerFromState(store.getState(), workspaceKey)).toEqual({
        kind: 'unresolved'
      })
    }
  )
})

describe('a new structured chat', () => {
  it.each<HostTwinKind>(['folder local+ssh', 'folder group local+ssh'])(
    'refuses a %s twin instead of starting on this computer',
    (kind) => {
      const { store, workspaceKey } = bind(createHostTwinFixture(kind))
      expect(resolveStructuredAgentSessionOwner(store.getState(), workspaceKey)).toBeNull()
      store.setState({ activeWorktreeId: workspaceKey, activeWorkspaceExecutionHostId: null })
      expect(resolveStructuredAgentSessionOwner(store.getState(), workspaceKey)).toBeNull()
    }
  )

  it('refuses an active worktree twin with no copy picked, and starts on the picked one', () => {
    const { store, workspaceKey } = bind(createHostTwinFixture('local+runtime'))
    store.setState({ activeWorktreeId: workspaceKey, activeWorkspaceExecutionHostId: null })
    expect(resolveStructuredAgentSessionOwner(store.getState(), workspaceKey)).toBeNull()
    store.setState({ activeWorkspaceExecutionHostId: RUNTIME_HOST })
    expect(resolveStructuredAgentSessionOwner(store.getState(), workspaceKey)).toBe(RUNTIME_HOST)
  })

  it("starts on the copy the user picked, and on a lone unstamped folder's computer", () => {
    const { store, workspaceKey, projectId } = bind(createHostTwinFixture('folder local+ssh'))
    store.setState({ activeWorktreeId: workspaceKey, activeWorkspaceExecutionHostId: 'local' })
    expect(resolveStructuredAgentSessionOwner(store.getState(), workspaceKey)).toBe('local')
    store.setState({
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      projectGroups: [],
      folderWorkspaces: [makeFolderWorkspace({ id: projectId, folderPath: '/work/twin' })]
    })
    expect(resolveStructuredAgentSessionOwner(store.getState(), workspaceKey)).toBe('local')
  })

  it('starts a lone unstamped worktree on this computer', () => {
    const fixture = bind(createHostTwinFixture('local+ssh'))
    const { store, workspaceKey, projectId } = fixture
    store.setState({
      repos: store.getState().repos.filter((repo) => !repo.connectionId),
      worktreesByRepo: {
        [projectId]: [makeWorktree({ id: workspaceKey, repoId: projectId, path: '/work/twin' })]
      }
    })
    expect(resolveStructuredAgentSessionOwner(store.getState(), workspaceKey)).toBe('local')
  })
})

describe('a workspace selected on the unresolved-owner sentinel', () => {
  it('neither reopens a terminal locally nor uploads an attachment', () => {
    const { store, workspaceKey } = runtimeOnly()
    store.setState({
      activeWorktreeId: workspaceKey,
      activeWorkspaceExecutionHostId: UNRESOLVED_OWNER_HOST_ID,
      recentlyClosedTerminalTabsByWorktree: { [workspaceKey]: [{}] }
    })
    expect(store.getState().reopenClosedTerminalTab(workspaceKey)).toBe(false)
    expect(resolveNativeChatAttachmentHost(store.getState(), workspaceKey)).toBeNull()
  })
})

describe('only this app owns the workspace', () => {
  it('reopens a closed terminal locally', () => {
    const fixture = bind(createHostTwinFixture('local+runtime'))
    const { store, workspaceKey, projectId } = fixture
    const state = store.getState()
    store.setState({
      repos: state.repos.filter((repo) => repo.executionHostId === 'local'),
      worktreesByRepo: {
        [projectId]: state.worktreesByRepo[projectId].filter((row) => row.hostId === 'local')
      },
      recentlyClosedTerminalTabsByWorktree: { [workspaceKey]: [{}] }
    })
    expect(store.getState().reopenClosedTerminalTab(workspaceKey)).toBe(true)
  })
})
