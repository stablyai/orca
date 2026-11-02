import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as ResolveOwnerModule from '@/lib/resolve-owner'
import type * as RuntimeRpcClientModule from './runtime-rpc-client'
import type * as RuntimeFileMutationClient from './runtime-file-mutation-client'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  LayoutApplyReply,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { TEST_REPO, makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { createEditorSaveQueue } from '@/components/editor/editor-save-queue'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { _resetLayoutFramePositionForTests } from './layout-frame-position'
import {
  CAPABLE,
  ENV,
  HOST_GROUP,
  SERVER_LAYOUT,
  WT,
  createFakeLayoutStreams,
  createServerHarness,
  settle,
  type TestStore
} from './server-layout-frames.test-fixture'
import { createFakeServerMain } from './server-layout-editor-handover.test-fixture'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import {
  isFrameDrawnServerWorkspace,
  resetFrameDrawnServerWorkspacesForTests
} from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { resetMirroredTerminalHandlesForTests } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

type Subscribe = (...args: never[]) => { close: () => void }
type Sent = { target: RuntimeClientTarget; command: LayoutCommand }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    subscribe: Subscribe | null
    sent: Sent[]
    reply: ((command: LayoutCommand) => Promise<LayoutApplyReply>) | null
    writeRuntimeFile: Mock
    closeSessionTab: Mock<
      (args: {
        worktreeId: string
        tabId: string
        environmentId?: string | null
      }) => Promise<string>
    >
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    subscribe: null,
    sent: [],
    reply: null,
    writeRuntimeFile: vi.fn(),
    closeSessionTab: vi.fn()
  })
)

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('@/lib/resolve-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolveOwnerModule>()),
  runtimeEnvironmentIdUnlessTwin: (_state: unknown, key: string) => hoisted.owners.get(key) ?? null
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return {
    ...actual,
    callRuntimeRpc: (target: RuntimeClientTarget, method: string, params?: unknown) => {
      if (method !== 'layout.apply') {
        return actual.callRuntimeRpc(target, method, params)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sender's params are `{ command }` with its workspace.
      const { command } = params as { command: LayoutCommand }
      hoisted.sent.push({ target, command })
      if (target.kind === 'local') {
        // This window's own main holds no tab of a workspace its row names no owner for: drawn here.
        return Promise.resolve({ ok: false, code: 'host_not_owned' })
      }
      if (!hoisted.reply) {
        throw new Error(`unexpected layout.apply ${command.type}`)
      }
      return hoisted.reply(command)
    }
  }
})

vi.mock('./web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: hoisted.closeSessionTab
}))

vi.mock('@/runtime/runtime-file-mutation-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileMutationClient>()),
  writeRuntimeFile: hoisted.writeRuntimeFile
}))

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

const FILE_PATH = '/worktree/src/a.ts'
const SECOND_PATH = '/worktree/src/b.ts'
/** The id this desktop gives the server's file, before the hand-over and after it. */
const desktopFileId = (path: string) => ownedEditorFileId(path, WT, ENV)
const serverFileId = (path: string) => ownedEditorFileId(path, WT, undefined)

/** Opens a file the way an editor action does; returns its file id and tab id. */
function openDesktopFile(
  store: TestStore,
  filePath: string,
  worktreeId = WT,
  env: string | null = ENV
) {
  const fileId = store.getState().openFile(
    {
      filePath,
      relativePath: filePath.slice('/worktree/'.length),
      worktreeId,
      runtimeEnvironmentId: env,
      language: 'typescript',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
  const tab = (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (entry) => entry.entityId === fileId
  )
  return { fileId, tabId: tab?.id }
}

/** An editor tab of a workspace no server owns, drawn as this window's own main would. */
function seedEditorTab(
  store: TestStore,
  worktreeId: string,
  filePath: string,
  executionHostId: ExecutionHostId
): void {
  const id = ownedEditorFileId(filePath, worktreeId, undefined)
  store.setState({
    openFiles: [
      ...store.getState().openFiles,
      {
        id,
        filePath,
        relativePath: 'a.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      }
    ]
  })
  store
    .getState()
    .createUnifiedTab(worktreeId, 'editor', { entityId: id, label: 'a.ts', executionHostId })
}

function editDraft(store: TestStore, fileId: string, draft: string): void {
  store.getState().setEditorDraft(fileId, draft)
  store.getState().markFileDirty(fileId, true)
}

const LOCAL_KEY = 'local-repo::/local'
const SSH_KEY = 'ssh-repo::/remote'
const RUNTIME_HOST = toRuntimeExecutionHostId(ENV)

/** The editor opens this window sent the ENV server. */
const serverOpens = () =>
  hoisted.sent.flatMap(({ target, command }) =>
    target.kind === 'environment' && command.type === 'openEditorTab' ? [command] : []
  )

const editorTabIds = (store: TestStore, key = WT) =>
  (store.getState().unifiedTabsByWorktree[key] ?? [])
    .filter((tab) => tab.contentType === 'editor')
    .map((tab) => tab.id)
const openFileIds = (store: TestStore, key = WT) =>
  store
    .getState()
    .openFiles.filter((file) => file.worktreeId === key)
    .map((file) => file.id)

/** The desktop's ENV server, its stream open and its snapshot in. */
async function connect(store: TestStore, server: ReturnType<typeof createFakeServerMain>) {
  install(store)
  setServers(store, [CAPABLE])
  const stream = streams.openTo(ENV)
  server.connect(stream)
  await settle()
  await settle()
  return stream
}

function serverWith() {
  const server = createFakeServerMain(streams, { [WT]: SERVER_LAYOUT })
  hoisted.reply = (command) => server.reply(command)
  hoisted.closeSessionTab.mockImplementation(async ({ worktreeId, tabId }) =>
    server.closeTab(worktreeId, tabId)
  )
  return server
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  hoisted.owners.clear()
  hoisted.sent.length = 0
  hoisted.reply = null
  hoisted.writeRuntimeFile.mockReset().mockResolvedValue({ ok: true })
  hoisted.closeSessionTab.mockReset().mockResolvedValue('failed')
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  vi.unstubAllGlobals()
  uninstallAll()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('a desktop-only editor tab when the server’s frames take its workspace', () => {
  it('is handed over under its own id, then drawn from the frames with its draft, once', async () => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    expect(fileId).toBe(desktopFileId(FILE_PATH))
    expect(tabId).toBeDefined()
    editDraft(store, fileId, 'unsaved')
    const server = serverWith()

    const stream = await connect(store, server)

    expect(hoisted.sent.map(({ target, command }) => [target, command])).toEqual([
      [
        { kind: 'environment', environmentId: ENV },
        expect.objectContaining({
          type: 'openEditorTab',
          workspace: WT,
          tabId,
          fileId: serverFileId(FILE_PATH),
          groupId: HOST_GROUP,
          contentType: 'editor',
          file: { filePath: FILE_PATH, relativePath: 'src/a.ts', language: 'typescript' }
        })
      ]
    ])
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).toContain(tabId)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)

    // The server's next records frame: the tab is the server's now, so it stays.
    const renamed = structuredClone(server.layout(WT)!)
    renamed.tabs[0]!.customTitle = 'named on the server'
    server.change(WT, renamed)
    await settle()

    expect(editorTabIds(store)).toEqual([tabId])
    expect(openFileIds(store)).toEqual([fileId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')
    expect(store.getState().tabsByWorktree[WT]?.[0]?.customTitle).toBe('named on the server')
    expect(stream.closed).toBe(false)
  })

  it('lets the server place a tab whose group only this desktop drew', async () => {
    const store = mirroredStore()
    const { tabId } = openDesktopFile(store, FILE_PATH)
    const desktopGroup = 'desktop-only-group'
    store.setState({
      groupsByWorktree: {
        [WT]: (store.getState().groupsByWorktree[WT] ?? []).map((group) => ({
          ...group,
          id: desktopGroup
        }))
      },
      unifiedTabsByWorktree: {
        [WT]: (store.getState().unifiedTabsByWorktree[WT] ?? []).map((tab) => ({
          ...tab,
          groupId: desktopGroup
        }))
      }
    })
    const server = serverWith()

    await connect(store, server)

    expect(serverOpens()).toHaveLength(1)
    expect(serverOpens()[0]).not.toHaveProperty('groupId')
    expect(server.layout(WT)?.groups[0]?.tabIds).toContain(tabId)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(editorTabIds(store)).toEqual([tabId])
  })

  it('keeps the tab and its draft on the mirror when the server answers `tab_exists`: its id is another tab’s there', async () => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    editDraft(store, fileId, 'unsaved')
    const server = serverWith()
    server.answer = { refuse: 'tab_exists' }

    await connect(store, server)

    expect(serverOpens()).toHaveLength(1)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
    expect(editorTabIds(store)).toEqual([tabId])
    expect(openFileIds(store)).toEqual([fileId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')
  })

  it('keeps the tab and its draft on the mirror for the stream after any other refusal', async () => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    editDraft(store, fileId, 'unsaved')
    const server = serverWith()
    server.answer = { refuse: 'group_not_found' }

    await connect(store, server)
    // The server's next records frame neither draws the workspace nor sends the tab again.
    const renamed = structuredClone(server.layout(WT)!)
    renamed.tabs[0]!.customTitle = 'named on the server'
    server.change(WT, renamed)
    await settle()

    expect(serverOpens()).toHaveLength(1)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
    expect(editorTabIds(store)).toEqual([tabId])
    expect(openFileIds(store)).toEqual([fileId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')
  })

  it('stays ungated with its tabs when the stream drops mid-hand-over; the next stream finishes it', async () => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    editDraft(store, fileId, 'unsaved')
    const server = serverWith()
    server.answer = 'pending'
    const stream = await connect(store, server)
    expect(serverOpens()).toHaveLength(1)

    stream.onStatus({ state: 'lost' })
    server.disconnect()
    // The server applies it, but its frame and answer reach no stream of this window's.
    server.release()
    await settle()
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
    expect(editorTabIds(store)).toEqual([tabId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')

    // The next stream's snapshot lists the tab: nothing to hand over, so it gates at once.
    stream.onStatus({ state: 'connecting' })
    server.answer = 'apply'
    server.connect(stream)
    await settle()

    expect(serverOpens()).toHaveLength(1)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(editorTabIds(store)).toEqual([tabId])
    expect(openFileIds(store)).toEqual([fileId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')
  })

  it('retries on the next stream after a call that never reached the server, and gates once it applies', async () => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    editDraft(store, fileId, 'unsaved')
    const server = serverWith()
    server.answer = 'throw'
    const stream = await connect(store, server)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)

    stream.onStatus({ state: 'lost' })
    stream.onStatus({ state: 'connecting' })
    server.answer = 'apply'
    server.connect(stream)
    await settle()
    await settle()

    expect(serverOpens().map((command) => command.tabId)).toEqual([tabId, tabId])
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(editorTabIds(store)).toEqual([tabId])
    expect(openFileIds(store)).toEqual([fileId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')
  })

  it('hands over a tab opened during the hand-over before gating, and skips one closed meanwhile', async () => {
    const store = mirroredStore()
    const first = openDesktopFile(store, FILE_PATH)
    const server = serverWith()
    server.answer = 'pending'
    await connect(store, server)
    expect(serverOpens()).toHaveLength(1)

    // Still mirror-drawn: these open here, as today.
    const second = openDesktopFile(store, SECOND_PATH)
    const closed = openDesktopFile(store, '/worktree/src/c.ts')
    expect(editorTabIds(store)).toEqual([first.tabId, second.tabId, closed.tabId])
    store.getState().closeFile(closed.fileId)
    server.answer = 'apply'
    server.release()
    await settle()
    await settle()

    expect(serverOpens().map((command) => command.tabId)).toEqual([first.tabId, second.tabId])
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(editorTabIds(store)).toEqual([first.tabId, second.tabId])
    expect(openFileIds(store)).toEqual([first.fileId, second.fileId])
  })

  it('closes the server’s copy of a tab the user closed while its hand-over was in flight', async () => {
    const store = mirroredStore()
    const kept = openDesktopFile(store, FILE_PATH)
    const closed = openDesktopFile(store, SECOND_PATH)
    const server = serverWith()
    server.answer = 'pending'
    await connect(store, server)
    expect(serverOpens().map((command) => command.tabId)).toEqual([kept.tabId, closed.tabId])

    store.getState().closeFile(closed.fileId)
    server.answer = 'apply'
    server.release()
    await settle()
    await settle()
    await settle()

    expect(hoisted.closeSessionTab).toHaveBeenCalledTimes(1)
    expect(hoisted.closeSessionTab).toHaveBeenCalledWith({
      worktreeId: WT,
      tabId: closed.tabId,
      environmentId: ENV,
      reason: 'user'
    })
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).not.toContain(closed.tabId)
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).toContain(kept.tabId)
    expect(editorTabIds(store)).toEqual([kept.tabId])
    expect(openFileIds(store)).toEqual([kept.fileId])
  })

  it('closes the server’s copy of a tab closed after its open applied, while another was in flight', async () => {
    const store = mirroredStore()
    const first = openDesktopFile(store, FILE_PATH)
    const second = openDesktopFile(store, SECOND_PATH)
    const server = serverWith()
    server.answer = 'pending'
    await connect(store, server)
    server.release(1)
    await settle()
    await settle()
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).toContain(first.tabId)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)

    store.getState().closeFile(first.fileId)
    server.answer = 'apply'
    server.release()
    await settle()
    await settle()
    await settle()

    expect(hoisted.closeSessionTab).toHaveBeenCalledTimes(1)
    expect(hoisted.closeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, tabId: first.tabId, environmentId: ENV })
    )
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).not.toContain(first.tabId)
    expect(editorTabIds(store)).toEqual([second.tabId])
    expect(openFileIds(store)).toEqual([second.fileId])
  })

  it('stays mirror-drawn when the server’s copy of a tab closed mid-hand-over cannot be closed', async () => {
    const store = mirroredStore()
    const closed = openDesktopFile(store, FILE_PATH)
    const server = serverWith()
    hoisted.closeSessionTab.mockResolvedValue('failed')
    server.answer = 'pending'
    await connect(store, server)

    store.getState().closeFile(closed.fileId)
    server.answer = 'apply'
    server.release()
    await settle()
    await settle()

    expect(hoisted.closeSessionTab).toHaveBeenCalledTimes(1)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
    expect(editorTabIds(store)).toEqual([])
  })

  it('routes an open in the gated workspace to the server, whose frames keep the tab', async () => {
    const store = mirroredStore()
    const server = serverWith()
    await connect(store, server)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)

    const { fileId } = openDesktopFile(store, FILE_PATH)
    editDraft(store, fileId, 'unsaved')
    await settle()
    await settle()
    const [open] = serverOpens()
    const renamed = structuredClone(server.layout(WT)!)
    renamed.tabs[0]!.customTitle = 'named on the server'
    server.change(WT, renamed)
    await settle()

    expect(open).toMatchObject({ fileId: serverFileId(FILE_PATH), groupId: HOST_GROUP })
    expect(editorTabIds(store)).toEqual([open!.tabId])
    expect(openFileIds(store)).toEqual([fileId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')
  })

  it('saves a handed-over file through the server, never this machine’s disk', async () => {
    const store = mirroredStore()
    store.setState({
      repos: [{ ...TEST_REPO, id: 'repo', path: '/worktree', executionHostId: RUNTIME_HOST }],
      worktreesByRepo: {
        repo: [makeWorktree({ id: WT, repoId: 'repo', path: '/worktree', hostId: RUNTIME_HOST })]
      }
    })
    const { fileId } = openDesktopFile(store, FILE_PATH)
    // Loaded from the server's disk before the hand-over.
    store.getState().setLastKnownDiskSignature(fileId, getDiskBaselineSignature('on disk'))
    editDraft(store, fileId, 'unsaved')
    await connect(store, serverWith())
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)

    const file = store.getState().openFiles.find((open) => open.id === fileId)!
    // The saved-file event goes nowhere here.
    vi.stubGlobal('window', { ...window, dispatchEvent: () => true })
    const saves = createEditorSaveQueue(store)
    const saved = await saves.queueSave(file, '', 'user')
    saves.dispose()
    expect(saved).toBe('written')

    expect(hoisted.writeRuntimeFile).toHaveBeenCalledTimes(1)
    expect(hoisted.writeRuntimeFile.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'environment', environmentId: ENV },
      worktreeId: WT
    })
    expect(hoisted.writeRuntimeFile.mock.calls[0]?.[2]).toBe('unsaved')
  })
})

/** Every layout.apply close this window sent anywhere. */
const layoutCloses = () => hoisted.sent.filter(({ command }) => command.type === 'closeTabs')

describe('closing a desktop editor tab after the hand-over', () => {
  it('closes a handed-over tab in the gated workspace by session.tabs.close, as other closes go', async () => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    const server = serverWith()
    await connect(store, server)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)

    store.getState().closeFile(fileId)
    await settle()
    await settle()

    expect(hoisted.closeSessionTab).toHaveBeenCalledTimes(1)
    expect(hoisted.closeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, tabId, environmentId: ENV, reason: 'user' })
    )
    expect(layoutCloses()).toEqual([])
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).not.toContain(tabId)
    expect(editorTabIds(store)).toEqual([])
    expect(openFileIds(store)).toEqual([])
  })

  it('closes a tab the server opened, in the frame-drawn workspace, by session.tabs.close', async () => {
    const store = mirroredStore()
    const server = serverWith()
    await connect(store, server)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    // Opened on the server itself (a phone, say): its frame draws it here.
    await server.reply({
      type: 'openEditorTab',
      tabId: 'server-editor-tab',
      fileId: serverFileId(FILE_PATH),
      contentType: 'editor',
      file: { filePath: FILE_PATH, relativePath: 'src/a.ts', language: 'typescript' },
      groupId: HOST_GROUP,
      workspace: WT
    })
    await settle()
    expect(editorTabIds(store)).toEqual(['server-editor-tab'])
    expect(openFileIds(store)).toEqual([desktopFileId(FILE_PATH)])

    store.getState().closeFile(desktopFileId(FILE_PATH))
    await settle()
    await settle()

    expect(hoisted.closeSessionTab).toHaveBeenCalledTimes(1)
    expect(hoisted.closeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: WT,
        tabId: 'server-editor-tab',
        environmentId: ENV,
        reason: 'user'
      })
    )
    expect(layoutCloses()).toEqual([])
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).not.toContain('server-editor-tab')
    expect(editorTabIds(store)).toEqual([])
  })

  it.each([
    { name: '`tab_exists`', answer: { refuse: 'tab_exists' } as const },
    { name: 'another refusal', answer: { refuse: 'group_not_found' } as const }
  ])('closes a tab kept on the mirror after $name here only', async ({ answer }) => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    const server = serverWith()
    server.answer = answer
    await connect(store, server)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
    const serverTabs = server.layout(WT)?.tabs.map((tab) => tab.id)

    store.getState().closeFile(fileId)
    await settle()
    await settle()

    expect(hoisted.closeSessionTab).not.toHaveBeenCalled()
    expect(layoutCloses().filter(({ target }) => target.kind === 'environment')).toEqual([])
    expect(server.layout(WT)?.tabs.map((tab) => tab.id)).toEqual(serverTabs)
    expect(editorTabIds(store)).not.toContain(tabId)
    expect(openFileIds(store)).toEqual([])
  })
})

describe('workspaces the hand-over never touches', () => {
  it('leaves a local and an SSH workspace’s editor tabs alone, even under keys the server publishes', async () => {
    const store = mirroredStore()
    seedEditorTab(store, LOCAL_KEY, '/local/a.ts', 'local')
    seedEditorTab(store, SSH_KEY, '/remote/a.ts', 'ssh:target-1')
    const localTabs = editorTabIds(store, LOCAL_KEY)
    const sshTabs = editorTabIds(store, SSH_KEY)
    expect(localTabs).toHaveLength(1)
    expect(sshTabs).toHaveLength(1)
    const server = createFakeServerMain(streams, {
      [WT]: SERVER_LAYOUT,
      [LOCAL_KEY]: { ...SERVER_LAYOUT, worktreeId: LOCAL_KEY },
      [SSH_KEY]: { ...SERVER_LAYOUT, worktreeId: SSH_KEY }
    })
    hoisted.reply = (command) => server.reply(command)

    await connect(store, server)

    expect(serverOpens()).toEqual([])
    expect(isFrameDrawnServerWorkspace(ENV, LOCAL_KEY)).toBe(false)
    expect(isFrameDrawnServerWorkspace(ENV, SSH_KEY)).toBe(false)
    expect(editorTabIds(store, LOCAL_KEY)).toEqual(localTabs)
    expect(editorTabIds(store, SSH_KEY)).toEqual(sshTabs)
  })

  it('makes no attempt for a server without layout intents, whose workspace keeps its tabs', async () => {
    const store = mirroredStore()
    const { fileId, tabId } = openDesktopFile(store, FILE_PATH)
    editDraft(store, fileId, 'unsaved')
    install(store)
    setServers(store, [{ ...CAPABLE, capable: false }])
    await settle()

    expect(streams.of(ENV)).toEqual([])
    expect(serverOpens()).toEqual([])
    expect(editorTabIds(store)).toEqual([tabId])
    expect(store.getState().editorDrafts[fileId]).toBe('unsaved')
  })
})
