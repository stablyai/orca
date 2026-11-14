import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type * as ResolveOwnerModule from '@/lib/workspace/ownership/resolve-owner'

import type * as RuntimeFileMutationClient from '../../files/mutations/runtime-file-mutation-client'
import type * as FrameDrawnModule from '../../web-session-tabs-sync/frame-drawn-server-workspaces'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type {
  LayoutApplyReply,
  LayoutCommand
} from '../../../../../shared/workspace-layout/workspace-layout-command-types'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { _resetLayoutFramePositionForTests } from '../frames/layout-frame-position'
import {
  CAPABLE,
  ENV,
  SERVER_LAYOUT,
  WT,
  createFakeLayoutStreams,
  createServerHarness,
  settle,
  type TestStore
} from './testing/server-layout-frames.test-fixture'
import { createFakeServerMain } from './testing/server-layout-editor-handover.test-fixture'
import { installLayoutFrameApplyCheck } from '../testing/workspace-layout-frame-apply-check.test-fixture'
import {
  isFrameDrawnServerWorkspace,
  resetFrameDrawnServerWorkspacesForTests
} from '../../web-session-tabs-sync/frame-drawn-server-workspace-set'
import { resetMirroredTerminalHandlesForTests } from '../../web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

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

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('../frames/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('../../web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('@/lib/workspace/ownership/resolve-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolveOwnerModule>()),
  runtimeEnvironmentIdUnlessTwin: (_state: unknown, key: string) => hoisted.owners.get(key) ?? null
}))
vi.mock('../../web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcCallModule>()
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

vi.mock('../../web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: hoisted.closeSessionTab
}))

vi.mock('@/runtime/files/mutations/runtime-file-mutation-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileMutationClient>()),
  writeRuntimeFile: hoisted.writeRuntimeFile
}))

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

const FILE_PATH = '/worktree/src/a.ts'
const SECOND_PATH = '/worktree/src/b.ts'

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

function editDraft(store: TestStore, fileId: string, draft: string): void {
  store.getState().setEditorDraft(fileId, draft)
  store.getState().markFileDirty(fileId, true)
}

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
})
