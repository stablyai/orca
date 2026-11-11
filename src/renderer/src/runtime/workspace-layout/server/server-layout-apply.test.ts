import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type * as ResolveOwnerModule from '@/lib/workspace/ownership/resolve-owner'

import type * as FrameDrawnModule from '../../web-session-tabs-sync/frame-drawn-server-workspaces'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { LayoutApplyReply } from '../../../../../shared/workspace-layout/workspace-layout-command-types'
import type { PublishedWorkspaceLayout } from '../../../../../shared/workspace-layout/workspace-layout-published'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import '../../../../../shared/workspace-session/workspace-session-pane-ownership'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import {
  _resetLayoutFramePositionForTests,
  beginLayoutFramePositions,
  noteLayoutFramePosition
} from '../frames/layout-frame-position'
import { sendLayoutApply, type WindowLayoutCommand } from '../commands/layout-apply-send'
import { mainLayoutFrameSender } from '../testing/main-loaded-layout-frames.test-fixture'
import './server-layout-apply'
import {
  CAPABLE,
  ENV,
  HOST_GROUP,
  LEAF_ID,
  SECOND_LEAF_ID,
  WT,
  createFakeLayoutStreams,
  createServerHarness,
  senderSnapshot,
  serverLayout,
  serverTerminalTab,
  settle,
  type TestStore
} from './testing/server-layout-frames.test-fixture'
import { resetFrameDrawnServerWorkspacesForTests } from '../../web-session-tabs-sync/frame-drawn-server-workspace-set'
import { resetMirroredTerminalHandlesForTests } from '../../web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

type Subscribe = (...args: never[]) => { close: () => void }
type Sent = { target: RuntimeClientTarget; params: unknown }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    subscribe: Subscribe | null
    sent: Sent[]
    reply: () => Promise<LayoutApplyReply>
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    subscribe: null,
    sent: [],
    reply: async () => ({ ok: true, result: {} })
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
      hoisted.sent.push({ target, params })
      return hoisted.reply()
    }
  }
})

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
const TAB_2 = toWebTerminalSurfaceTabId('host-tab-2')
// The server's tab-bar ids differ from its terminals' ids: the join must not derive one from the other.
const TWO_TABS: PublishedWorkspaceLayout = (() => {
  const tabs = [
    { ...serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'), id: 'bar-1' },
    { ...serverTerminalTab('host-tab-2', SECOND_LEAF_ID, 'server-pty-2'), id: 'bar-2' }
  ]
  return { ...serverLayout(tabs), groups: [{ id: HOST_GROUP, tabIds: ['bar-1', 'bar-2'] }] }
})()

const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

async function drawnByServer(layout = TWO_TABS) {
  const store = mirroredStore()
  install(store)
  setServers(store, [CAPABLE])
  const stream = streams.openTo(ENV)
  const frames = mainLayoutFrameSender()
  streams.send(stream, senderSnapshot(frames, { [WT]: layout }, 1))
  await settle()
  return { store, stream, frames }
}

function send(store: TestStore, command: WindowLayoutCommand) {
  const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }
  const taken = sendLayoutApply(store.getState(), WT, command, handlers)
  return { taken, handlers }
}

const orderOf = (store: TestStore) =>
  store.getState().groupsByWorktree[WT]?.find((group) => group.id === HOST_GROUP)?.tabOrder

beforeEach(() => {
  hoisted.owners.clear()
  hoisted.sent.length = 0
  hoisted.reply = async () => ({ ok: true, result: {} })
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(uninstallAll)

describe('a layout intent for a workspace a server’s frames draw', () => {
  it('goes to that server’s main under its ids, and shows once that server’s frame is in', async () => {
    const { store, stream, frames } = await drawnByServer()
    expect(orderOf(store)).toEqual([TAB_1, TAB_2])
    hoisted.reply = async () => ({ ok: true, result: { tabId: 'bar-2' }, frameSeq: 2 })
    // This window's own main is far ahead: its frames must not release a server's reply.
    beginLayoutFramePositions()
    noteLayoutFramePosition(50)

    const { taken, handlers } = send(store, {
      type: 'moveTab',
      tabId: TAB_2,
      toGroupId: HOST_GROUP,
      index: 0
    })
    await settle()

    expect(taken).toBe(true)
    expect(hoisted.sent).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: {
          command: {
            type: 'moveTab',
            tabId: 'bar-2',
            toGroupId: HOST_GROUP,
            index: 0,
            afterTabId: null,
            workspace: WT
          }
        }
      }
    ])
    expect(handlers.apply).not.toHaveBeenCalled()

    const moved = structuredClone(TWO_TABS)
    moved.groups[0]!.tabIds = ['bar-2', 'bar-1']
    streams.send(stream, frames.records(WT, moved))
    await settle()

    expect(orderOf(store)).toEqual([TAB_2, TAB_1])
    expect(handlers.apply).toHaveBeenCalledWith({ tabId: TAB_2 }, { framesKey: ENV, routed: true })
    expect(handlers.asToday).not.toHaveBeenCalled()
  })
})
