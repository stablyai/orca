import { mountedBellSession } from './worktree-terminal-bell.fixture'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { closeTestStores, createSqliteTestStore } from '../../src/main/persistence-test-harness'
import { Store } from '../../src/main/persistence/loading-store/store'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { registerWorktreeMetadataHandlers } from '../../src/main/ipc/worktrees/metadata/register-worktree-metadata-handlers'
import { createSenderScopedRequestCancellations } from '../../src/main/ipc/sender-scoped-request-cancellation'
import { listFolderWorkspaces } from '../../src/main/ipc/worktrees/listing/folder-workspace-catalog'
import {
  createTestStore,
  makeTab,
  makeWorktree
} from '../../src/renderer/src/store/slices/store-test-helpers'
import { createWorktreeIdentity } from '../../src/shared/worktree/identity'
import type { ExecutionHostId } from '../../src/shared/execution-host'
import type { WorktreeApi } from '../../src/preload/api/worktree-api'
import type {
  DirectSshWorktreeFetchOptions,
  WorktreeFetchOptions
} from '../../src/renderer/src/store/slices/worktree-helpers'
import type { HostQualifiedDetectedWorktreeResult } from '../../src/shared/detected-worktree-provider-contract'
import { WORKTREE_METHODS } from '../../src/main/runtime/rpc/methods/worktree'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '../../src/renderer/src/runtime/runtime-rpc-client'
import type { RuntimeEnvironmentCallRequest } from '../../src/renderer/src/runtime/runtime-compatibility-test-fixture'
import { withRepoHostOwnership } from '../../src/renderer/src/store/slices/worktrees/listing/worktree-host-ownership'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0',
    isPackaged: false,
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler),
    on: vi.fn()
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
    webContents = { send: vi.fn() }
    isDestroyed() {
      return false
    }
  }
}))

const directories: string[] = []
const stores: Store[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flushPendingOrThrowAsync()))
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  handlers.clear()
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type MetadataRequest = Parameters<WorktreeApi['updateMeta']>[0]

function fetchWorktrees(
  repoId: string,
  options: DirectSshWorktreeFetchOptions
): Promise<HostQualifiedDetectedWorktreeResult>
function fetchWorktrees(repoId: string, options?: WorktreeFetchOptions): Promise<boolean>
async function fetchWorktrees(
  _repoId: string,
  options?: WorktreeFetchOptions
): Promise<HostQualifiedDetectedWorktreeResult | boolean> {
  if (options && 'directSshAuthority' in options) {
    throw new Error('fixture_unexpected_direct_ssh_scan')
  }
  return true
}

function fixture(hostId: ExecutionHostId = 'local') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-metadata-producer-')))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  const repo = {
    id: 'repo-1',
    path: join(directory, 'project'),
    kind: 'folder' as const,
    displayName: 'Folder project',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: hostId
  }
  mkdirSync(repo.path)
  store.addRepo(repo)
  const id = `${repo.id}::${repo.path}::workspace:11111111-1111-4111-8111-111111111111`
  store.setWorktreeMetaForHost(id, hostId, {
    instanceId: 'old-instance',
    displayName: 'Named workspace',
    lastActivityAt: 1
  })
  const runtime = new OrcaRuntimeService(store)
  const notify = vi.spyOn(runtime, 'notifyWorktreesChangedForRemoteClients')
  registerWorktreeMetadataHandlers({
    store,
    runtime,
    mainWindow: new BrowserWindow({ show: false }),
    detectedWorktreeCancellations: createSenderScopedRequestCancellations(),
    worktreeRemovalsInFlight: new Map()
  })
  const handler = handlers.get('worktrees:updateMeta')
  if (!handler) {
    throw new Error('fixture_missing_handler')
  }
  const renderer = createTestStore()
  const worktree = listFolderWorkspaces(store, repo).find((row) => row.id === id)
  if (!worktree?.identity) {
    throw new Error('fixture_missing_published_folder_identity')
  }

  renderer.setState({ repos: [repo], worktreesByRepo: { [repo.id]: [worktree] }, fetchWorktrees })
  const updateMeta = vi.fn((args: MetadataRequest) =>
    Promise.resolve(handler({}, structuredClone(args)))
  )
  vi.stubGlobal('window', { api: { worktrees: { updateMeta } } })
  return {
    store,
    runtime,
    repo,
    id,
    dataFile,
    renderer,
    handler,
    updateMeta,
    notify,
    fetchWorktrees
  }
}

function lastRequest(updateMeta: ReturnType<typeof fixture>['updateMeta']): MetadataRequest {
  const args = updateMeta.mock.calls.at(-1)?.[0]
  if (!args) {
    throw new Error('fixture_missing_request')
  }
  return args
}

async function reopen(store: Store, dataFile: string) {
  await store.flushPendingOrThrowAsync()
  const reopened = createSqliteTestStore(Store, { dataFile })
  stores.push(reopened)
  return reopened
}

describe('renderer metadata producer to authoritative IPC Store', () => {
  it.each(['activity', 'unread', 'clear-unread'] as const)(
    'does not resurrect a removed folder instance through %s',
    async (producer) => {
      const { store, repo, id, dataFile, renderer, updateMeta, notify } = fixture()
      if (producer === 'clear-unread') {
        renderer.setState({
          worktreesByRepo: {
            [repo.id]: renderer
              .getState()
              .worktreesByRepo[repo.id].map((row) => ({ ...row, isUnread: true }))
          }
        })
      }
      store.removeWorktreeMeta(id, 'local')
      const before = structuredClone(store.getAllWorktreeMeta())
      if (producer === 'activity') {
        renderer.getState().bumpWorktreeActivity(id)
      } else if (producer === 'unread') {
        renderer.getState().markWorktreeUnread(id)
      } else {
        renderer.getState().clearWorktreeUnread(id)
      }
      await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
      expect(lastRequest(updateMeta)).toEqual(
        expect.objectContaining({
          worktreeId: id,
          executionHostId: 'local',
          expectedInstanceId: 'old-instance'
        })
      )
      expect(await updateMeta.mock.results[0].value).toBeNull()
      expect(store.getAllWorktreeMeta()).toEqual(before)
      expect(store.getWorktreeMetaForHost(id, 'local')).toBeUndefined()
      expect(notify).not.toHaveBeenCalled()
      expect(listFolderWorkspaces(store, repo).some((row) => row.id === id)).toBe(false)
      expect((await reopen(store, dataFile)).getWorktreeMetaForHost(id, 'local')).toBeUndefined()
    }
  )

  it('captures instance before IPC delivery and rejects a delayed request after remove/re-add', async () => {
    const { store, id, dataFile, renderer, handler, updateMeta } = fixture()
    let deliver: (() => void) | undefined
    updateMeta.mockImplementation(
      (args) =>
        new Promise((resolve) => {
          deliver = () => resolve(handler({}, structuredClone(args)))
        })
    )
    const tab = makeTab({ id: 'delayed-bind-tab', worktreeId: id })
    renderer.setState({ tabsByWorktree: { [id]: [tab] } })
    renderer.getState().updateTabPtyId(tab.id, 'fixture-delayed-local-pty')
    expect(lastRequest(updateMeta).expectedInstanceId).toBe('old-instance')
    store.removeWorktreeMeta(id, 'local')
    const replacement = structuredClone(
      store.setWorktreeMetaForHost(id, 'local', {
        instanceId: 'new-instance',
        displayName: 'Re-added',
        lastActivityAt: 2
      })
    )
    if (!deliver) {
      throw new Error('fixture_missing_delivery')
    }
    deliver()
    expect(await updateMeta.mock.results[0].value).toBeNull()
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(replacement)
    expect((await reopen(store, dataFile)).getWorktreeMetaForHost(id, 'local')).toEqual(replacement)
  })

  it('routes client-owned SSH activity through local IPC with the exact execution host', async () => {
    const { store, repo, id, renderer, updateMeta } = fixture('ssh:target-a')
    store.addRepo({ ...repo, executionHostId: 'local' })
    const local = structuredClone(
      store.setWorktreeMetaForHost(id, 'local', {
        instanceId: 'local-instance',
        lastActivityAt: 2,
        displayName: 'Local sibling'
      })
    )
    renderer.getState().bumpWorktreeActivity(id)
    await updateMeta.mock.results[0].value
    const args = lastRequest(updateMeta)
    expect(args.executionHostId).toBe('ssh:target-a')
    expect(args.expectedInstanceId).toBe('old-instance')
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(local)
    expect(store.getWorktreeMetaForHost(id, 'ssh:target-a')?.lastActivityAt).toBe(
      args.updates.lastActivityAt
    )
  })

  it('persists a current manual rename with its provenance through SQLite reload', async () => {
    const { store, id, dataFile, renderer, notify, updateMeta } = fixture()
    expect(await renderer.getState().updateWorktreeMeta(id, { displayName: 'Renamed' })).toEqual({
      ok: true
    })
    expect(lastRequest(updateMeta).expectedInstanceId).toBe('old-instance')
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(
      expect.objectContaining({
        displayName: 'Renamed',
        displayNameIsPinned: true,
        instanceId: 'old-instance'
      })
    )
    expect(notify).toHaveBeenCalledExactlyOnceWith('repo-1')
    const renamed = structuredClone(store.getWorktreeMetaForHost(id, 'local'))
    expect((await reopen(store, dataFile)).getWorktreeMetaForHost(id, 'local')).toEqual(renamed)
  })

  it('returns unavailable for a manual edit of a removed instance', async () => {
    const { store, id, renderer, notify } = fixture()
    store.removeWorktreeMeta(id, 'local')
    expect(await renderer.getState().updateWorktreeMeta(id, { comment: 'late' })).toEqual({
      ok: false,
      error: 'This workspace is no longer available.'
    })
    expect(store.getWorktreeMetaForHost(id, 'local')).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })
  it('does not apply queued review notes to a replacement occupant', async () => {
    const { store, id, dataFile, renderer, handler, updateMeta } = fixture()
    let deliver: (() => void) | undefined
    updateMeta.mockImplementation(
      (args) =>
        new Promise((resolve) => {
          deliver = () => resolve(handler({}, structuredClone(args)))
        })
    )
    const pending = renderer.getState().addDiffComment({
      worktreeId: id,
      filePath: 'note.ts',
      lineNumber: 1,
      body: 'old note',
      side: 'modified'
    })
    await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
    expect(lastRequest(updateMeta)).toEqual(
      expect.objectContaining({
        executionHostId: 'local',
        expectedInstanceId: 'old-instance'
      })
    )
    store.removeWorktreeMeta(id, 'local')
    const replacement = structuredClone(
      store.setWorktreeMetaForHost(id, 'local', {
        instanceId: 'replacement-instance',
        comment: 'replacement'
      })
    )
    if (!deliver) {
      throw new Error('fixture_missing_delivery')
    }
    deliver()
    expect(await pending).toBeNull()
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(replacement)
    expect((await reopen(store, dataFile)).getWorktreeMetaForHost(id, 'local')).toEqual(replacement)
  })

  it('drops an old queued continuation before sending to a re-added renderer occupant', async () => {
    const { store, repo, id, renderer, handler, updateMeta } = fixture()
    let deliver: (() => void) | undefined
    updateMeta.mockImplementation(
      (args) =>
        new Promise((resolve) => {
          deliver = () => resolve(handler({}, structuredClone(args)))
        })
    )
    const input = { worktreeId: id, filePath: 'note.ts', lineNumber: 1, side: 'modified' as const }
    const first = renderer.getState().addDiffComment({ ...input, body: 'first old note' })
    await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
    const second = renderer.getState().addDiffComment({ ...input, body: 'queued old note' })
    store.removeWorktreeMeta(id, 'local')
    const persistedReplacement = structuredClone(
      store.setWorktreeMetaForHost(id, 'local', {
        instanceId: 'replacement-instance',
        comment: 'replacement'
      })
    )
    const replacement = makeWorktree({
      ...renderer.getState().worktreesByRepo[repo.id][0],
      instanceId: 'replacement-instance',
      diffComments: [],
      identity: createWorktreeIdentity({
        worktreeId: id,
        executionHostId: 'local',
        instanceId: 'replacement-instance'
      })
    })
    renderer.setState({ worktreesByRepo: { [repo.id]: [replacement] } })
    if (!deliver) {
      throw new Error('fixture_missing_delivery')
    }
    deliver()
    expect(await Promise.all([first, second])).toEqual([null, null])
    expect(updateMeta).toHaveBeenCalledTimes(1)
    expect(renderer.getState().worktreesByRepo[repo.id]).toEqual([replacement])
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(persistedReplacement)
  })

  it('writes review notes only to the selected SSH sibling', async () => {
    const { store, repo, id, renderer, updateMeta } = fixture('ssh:target-a')
    const localRepo = { ...repo, executionHostId: 'local' as const }
    store.addRepo(localRepo)
    const localMeta = structuredClone(
      store.setWorktreeMetaForHost(id, 'local', {
        instanceId: 'local-instance',
        comment: 'local'
      })
    )
    const sshRow = renderer.getState().worktreesByRepo[repo.id][0]
    const localRow = makeWorktree({
      ...sshRow,
      hostId: 'local',
      instanceId: 'local-instance',
      identity: createWorktreeIdentity({
        worktreeId: id,
        executionHostId: 'local',
        instanceId: 'local-instance'
      })
    })
    renderer.setState({
      repos: [repo, localRepo],
      worktreesByRepo: { [repo.id]: [localRow, sshRow] },
      activeWorktreeId: id,
      activeWorkspaceExecutionHostId: 'ssh:target-a'
    })
    const saved = await renderer.getState().addDiffComment({
      worktreeId: id,
      filePath: 'note.ts',
      lineNumber: 1,
      side: 'modified',
      body: 'SSH note'
    })
    expect(saved?.body).toBe('SSH note')
    expect(lastRequest(updateMeta)).toEqual(
      expect.objectContaining({
        executionHostId: 'ssh:target-a',
        expectedInstanceId: 'old-instance'
      })
    )
    expect(renderer.getState().worktreesByRepo[repo.id][0]).toBe(localRow)
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(localMeta)
    expect(store.getWorktreeMetaForHost(id, 'ssh:target-a')?.diffComments).toEqual([saved])
  })

  it.each(['activity', 'unread', 'clear-unread'] as const)(
    'keeps the local renderer sibling unchanged during SSH %s',
    async (producer) => {
      const { store, repo, id, renderer, updateMeta } = fixture('ssh:target-a')
      const localRepo = { ...repo, executionHostId: 'local' as const }
      store.addRepo(localRepo)
      const localMeta = structuredClone(
        store.setWorktreeMetaForHost(id, 'local', {
          instanceId: 'local-instance',
          isUnread: true,
          lastActivityAt: 2
        })
      )
      const sshRow = {
        ...renderer.getState().worktreesByRepo[repo.id][0],
        isUnread: producer === 'clear-unread'
      }
      const localRow = makeWorktree({
        ...sshRow,
        hostId: 'local',
        instanceId: 'local-instance',
        isUnread: true,
        identity: createWorktreeIdentity({
          worktreeId: id,
          executionHostId: 'local',
          instanceId: 'local-instance'
        })
      })
      renderer.setState({
        repos: [localRepo, repo],
        worktreesByRepo: { [repo.id]: [localRow, sshRow] },
        activeWorktreeId: id,
        activeWorkspaceExecutionHostId: 'ssh:target-a'
      })
      if (producer === 'activity') {
        renderer.getState().bumpWorktreeActivity(id)
      } else if (producer === 'unread') {
        renderer.getState().markWorktreeUnread(id)
      } else {
        renderer.getState().clearWorktreeUnread(id)
      }
      await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
      await updateMeta.mock.results[0].value
      expect(lastRequest(updateMeta)).toEqual(
        expect.objectContaining({
          executionHostId: 'ssh:target-a',
          expectedInstanceId: 'old-instance'
        })
      )
      expect(renderer.getState().worktreesByRepo[repo.id][0]).toBe(localRow)
      expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(localMeta)
    }
  )

  it.each([
    ['bind', 'local'],
    ['release', 'local'],
    ['bind', 'ssh:target-a'],
    ['release', 'ssh:target-a']
  ] as const)(
    'keeps %s PTY activity on its %s owner while the sibling is selected',
    async (action, hostId) => {
      const { store, repo, id, dataFile, renderer, updateMeta } = fixture(hostId)
      const otherHost = hostId === 'local' ? 'ssh:target-a' : 'local'
      const otherRepo: typeof repo = { ...repo, executionHostId: otherHost }
      store.addRepo(otherRepo)
      const siblingMeta = structuredClone(
        store.setWorktreeMetaForHost(id, otherHost, {
          instanceId: 'sibling-instance',
          lastActivityAt: 2
        })
      )
      const row = renderer.getState().worktreesByRepo[repo.id][0]
      const sibling = makeWorktree({
        ...row,
        hostId: otherHost,
        instanceId: 'sibling-instance',
        identity: createWorktreeIdentity({
          worktreeId: id,
          executionHostId: otherHost,
          instanceId: 'sibling-instance'
        })
      })
      const ptyId = hostId === 'local' ? 'fixture-local-pty' : 'ssh:target-a@@fixture-pty'
      const tab = makeTab({
        id: 'fixture-terminal',
        worktreeId: id,
        ptyId: action === 'release' ? ptyId : null
      })
      renderer.setState({
        repos: [repo, otherRepo],
        worktreesByRepo: { [repo.id]: [row, sibling] },
        activeWorktreeId: id,
        activeWorkspaceExecutionHostId: otherHost,
        tabsByWorktree: { [id]: [tab] },
        ptyIdsByTabId: { [tab.id]: action === 'release' ? [ptyId] : [] }
      })
      if (action === 'bind') {
        renderer.getState().updateTabPtyId(tab.id, ptyId)
      } else {
        renderer.getState().clearTabPtyId(tab.id, ptyId)
      }
      await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
      await updateMeta.mock.results[0].value
      expect(lastRequest(updateMeta)).toEqual(
        expect.objectContaining({
          executionHostId: hostId,
          expectedInstanceId: 'old-instance'
        })
      )
      expect(renderer.getState().worktreesByRepo[repo.id][1]).toBe(sibling)
      expect(store.getWorktreeMetaForHost(id, otherHost)).toEqual(siblingMeta)
      expect(store.getWorktreeMetaForHost(id, hostId)?.lastActivityAt).toBeGreaterThan(1)
      expect((await reopen(store, dataFile)).getWorktreeMetaForHost(id, otherHost)).toEqual(
        siblingMeta
      )
    }
  )

  it.each(['local', 'ssh:target-a'] as const)(
    'keeps mounted %s BEL unread on its captured owner and refuses a replacement',
    async (hostId) => {
      const { store, repo, id, renderer, updateMeta, dataFile } = fixture(hostId)
      const otherHost = hostId === 'local' ? 'ssh:target-a' : 'local'
      const otherRepo: typeof repo = { ...repo, executionHostId: otherHost }
      store.addRepo(otherRepo)
      const siblingMeta = structuredClone(
        store.setWorktreeMetaForHost(id, otherHost, {
          instanceId: 'sibling-instance',
          isUnread: false
        })
      )
      const row = renderer.getState().worktreesByRepo[repo.id][0]
      const sibling = makeWorktree({
        ...row,
        hostId: otherHost,
        instanceId: 'sibling-instance',
        identity: createWorktreeIdentity({
          worktreeId: id,
          executionHostId: otherHost,
          instanceId: 'sibling-instance'
        })
      })
      renderer.setState({
        repos: [repo, otherRepo],
        worktreesByRepo: { [repo.id]: [row, sibling] },
        activeWorktreeId: id,
        activeWorkspaceExecutionHostId: otherHost
      })
      const session = mountedBellSession(renderer, id, hostId)
      session.onBell()
      session.clearTerminalBellNotificationTimer()
      await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
      await updateMeta.mock.results[0].value
      expect(lastRequest(updateMeta)).toEqual(
        expect.objectContaining({
          executionHostId: hostId,
          expectedInstanceId: 'old-instance',
          updates: { isUnread: true, lastActivityAt: expect.any(Number) }
        })
      )
      expect(renderer.getState().worktreesByRepo[repo.id][1]).toBe(sibling)
      expect(store.getWorktreeMetaForHost(id, otherHost)).toEqual(siblingMeta)
      expect(store.getWorktreeMetaForHost(id, hostId)?.isUnread).toBe(true)
      await store.flushPendingOrThrowAsync()
      store.removeWorktreeMeta(id, hostId)
      const replacementMeta = structuredClone(
        store.setWorktreeMetaForHost(id, hostId, {
          instanceId: 'replacement-instance',
          isUnread: false
        })
      )
      const replacement = makeWorktree({
        ...row,
        instanceId: 'replacement-instance',
        isUnread: false,
        identity: createWorktreeIdentity({
          worktreeId: id,
          executionHostId: hostId,
          instanceId: 'replacement-instance'
        })
      })
      renderer.setState({ worktreesByRepo: { [repo.id]: [replacement, sibling] } })
      updateMeta.mockClear()
      session.onBell()
      session.clearTerminalBellNotificationTimer()
      await Promise.resolve()
      expect(updateMeta).not.toHaveBeenCalled()
      expect(renderer.getState().worktreesByRepo[repo.id]).toEqual([replacement, sibling])
      expect(store.getWorktreeMetaForHost(id, hostId)).toEqual(replacementMeta)
      expect(store.getWorktreeMetaForHost(id, otherHost)).toEqual(siblingMeta)
      expect((await reopen(store, dataFile)).getWorktreeMetaForHost(id, hostId)).toEqual(
        replacementMeta
      )
    }
  )

  it.each([
    ['activity', 'paired-a'],
    ['unread', 'paired-a'],
    ['activity', 'paired-b'],
    ['unread', 'paired-b']
  ] as const)(
    'keeps private SSH %s on publisher %s when another publisher has the same host and locator',
    async (producer, publisher) => {
      const { store, runtime, repo, id, renderer, updateMeta } = fixture('ssh:target-a')
      const method = WORKTREE_METHODS.find((candidate) => candidate.name === 'worktree.set')
      if (!method || method.name !== 'worktree.set') {
        throw new Error('fixture_missing_rpc_method')
      }
      const call = vi.fn(async (request: RuntimeEnvironmentCallRequest) => ({
        id: 'paired-call',
        ok: true,
        result: await method.handler(method.params.parse(structuredClone(request.params)), {
          runtime
        }),
        _meta: { runtimeId: 'fixture-runtime' }
      }))
      vi.stubGlobal('window', { api: { worktrees: { updateMeta }, runtimeEnvironments: { call } } })
      const row = renderer.getState().worktreesByRepo[repo.id][0]
      const otherPublisher = publisher === 'paired-a' ? 'paired-b' : 'paired-a'
      const owner = withRepoHostOwnership(row, `runtime:${publisher}`)
      const sibling = withRepoHostOwnership(
        makeWorktree({
          ...row,
          instanceId: 'sibling-instance',
          identity: createWorktreeIdentity({
            worktreeId: id,
            executionHostId: 'ssh:target-a',
            instanceId: 'sibling-instance'
          })
        }),
        `runtime:${otherPublisher}`
      )
      renderer.setState({
        repos: [
          { ...repo, executionHostId: 'runtime:paired-a', connectionId: 'target-a' },
          { ...repo, executionHostId: 'runtime:paired-b', connectionId: 'target-a' }
        ],
        worktreesByRepo: { [repo.id]: [sibling, owner] }
      })
      markRuntimeEnvironmentCompatible(publisher)
      if (producer === 'unread') {
        const session = mountedBellSession(renderer, id, 'ssh:target-a', publisher)
        session.onBell()
        session.clearTerminalBellNotificationTimer()
      } else {
        renderer.getState().bumpWorktreeActivity(id, {
          executionHostId: 'ssh:target-a',
          runtimeEnvironmentId: publisher,
          expectedInstanceId: 'old-instance'
        })
      }
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      await call.mock.results[0].value
      expect(call.mock.calls[0][0]).toEqual(expect.objectContaining({ selector: publisher }))
      expect(store.getWorktreeMetaForHost(id, 'ssh:target-a')?.lastActivityAt).toBeGreaterThan(1)
      if (producer === 'unread') {
        expect(store.getWorktreeMetaForHost(id, 'ssh:target-a')?.isUnread).toBe(true)
      }
      expect(renderer.getState().worktreesByRepo[repo.id][0]).toBe(sibling)
      if (producer === 'unread') {
        expect(renderer.getState().worktreesByRepo[repo.id][1]?.isUnread).toBe(true)
      }
    }
  )

  it.each(['activity', 'unread', 'clear-unread'] as const)(
    'refuses %s when a terminal cannot verify its owner',
    async (producer) => {
      const { store, repo, id, renderer, updateMeta } = fixture()
      const row = {
        ...renderer.getState().worktreesByRepo[repo.id][0],
        isUnread: producer === 'clear-unread'
      }
      renderer.setState({
        worktreesByRepo: { [repo.id]: [row] },
        activeWorktreeId: id,
        activeWorkspaceExecutionHostId: 'local'
      })
      const before = structuredClone(store.getAllWorktreeMeta())
      if (producer === 'activity') {
        renderer.getState().bumpWorktreeActivity(id, null)
      } else if (producer === 'unread') {
        renderer.getState().markWorktreeUnread(id, null)
      } else {
        renderer.getState().clearWorktreeUnread(id, null)
      }
      await Promise.resolve()
      expect(renderer.getState().worktreesByRepo[repo.id][0]).toBe(row)
      expect(store.getAllWorktreeMeta()).toEqual(before)
      expect(updateMeta).not.toHaveBeenCalled()
    }
  )

  it('reconciles activity after an unexpected IPC failure and keeps selector misses quiet', async () => {
    const { repo, id, renderer, updateMeta } = fixture()
    const fetch = vi.spyOn(renderer.getState(), 'fetchWorktrees')
    const error = new Error('fixture_metadata_write_failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateMeta.mockRejectedValueOnce(error)
    renderer.getState().bumpWorktreeActivity(id)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledExactlyOnceWith(repo.id))
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Failed to persist worktree activity timestamp:',
      error
    )
    fetch.mockClear()
    log.mockClear()
    updateMeta.mockResolvedValueOnce(null)
    renderer.getState().bumpWorktreeActivity(id)
    await updateMeta.mock.results[1].value
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('does not apply a manual review link after its push-target lookup crosses remove/re-add', async () => {
    const { store, repo, id, renderer, updateMeta, notify } = fixture()
    let finish: ((result: { error: string }) => void) | undefined
    const resolvePrBase = vi.fn(
      () =>
        new Promise<{ error: string }>((resolve) => {
          finish = resolve
        })
    )
    vi.stubGlobal('window', { api: { worktrees: { updateMeta, resolvePrBase } } })
    const pending = renderer.getState().updateWorktreeMeta(id, { linkedPR: 42 })
    expect(resolvePrBase).toHaveBeenCalledExactlyOnceWith({ repoId: repo.id, prNumber: 42 })
    store.removeWorktreeMeta(id, 'local')
    const persistedReplacement = structuredClone(
      store.setWorktreeMetaForHost(id, 'local', {
        instanceId: 'replacement-instance',
        linkedPR: 7
      })
    )
    const replacement = makeWorktree({
      ...renderer.getState().worktreesByRepo[repo.id][0],
      instanceId: 'replacement-instance',
      linkedPR: 7,
      identity: createWorktreeIdentity({
        worktreeId: id,
        executionHostId: 'local',
        instanceId: 'replacement-instance'
      })
    })
    renderer.setState({ worktreesByRepo: { [repo.id]: [replacement] } })
    if (!finish) {
      throw new Error('fixture_missing_lookup')
    }
    finish({ error: 'fixture_no_push_target' })
    expect(await pending).toEqual({ ok: false, error: 'This workspace is no longer available.' })
    expect(updateMeta).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(renderer.getState().worktreesByRepo[repo.id]).toEqual([replacement])
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(persistedReplacement)
  })

  it('preserves the raw identity through a paired producer and production RPC handler', async () => {
    const { store, runtime, repo, id, renderer, updateMeta, dataFile } = fixture()
    const method = WORKTREE_METHODS.find((candidate) => candidate.name === 'worktree.set')
    if (!method || method.name !== 'worktree.set') {
      throw new Error('fixture_missing_rpc_method')
    }
    const call = vi.fn(async (request: RuntimeEnvironmentCallRequest) => ({
      id: 'paired-call',
      ok: true,
      result: await method.handler(method.params.parse(structuredClone(request.params)), {
        runtime
      }),
      _meta: { runtimeId: 'fixture-runtime' }
    }))
    vi.stubGlobal('window', { api: { worktrees: { updateMeta }, runtimeEnvironments: { call } } })
    const original = renderer.getState().worktreesByRepo[repo.id][0]
    renderer.setState({
      repos: [{ ...repo, executionHostId: 'runtime:paired' }],
      worktreesByRepo: {
        [repo.id]: [withRepoHostOwnership(original, 'runtime:paired')]
      }
    })
    markRuntimeEnvironmentCompatible('paired')
    renderer.getState().markWorktreeUnread(id)
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        method: 'worktree.set',
        params: {
          worktree: 'identity:wt2:local:old-instance',
          isUnread: true,
          lastActivityAt: expect.any(Number)
        }
      })
    )
    await call.mock.results[0].value
    expect(updateMeta).not.toHaveBeenCalled()
    expect(store.getWorktreeMetaForHost(id, 'local')?.isUnread).toBe(true)
    expect((await reopen(store, dataFile)).getWorktreeMetaForHost(id, 'local')?.isUnread).toBe(true)
  })
})
