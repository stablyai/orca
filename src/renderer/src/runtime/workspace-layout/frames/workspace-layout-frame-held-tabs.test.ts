import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { LayoutApplyReply } from '../../../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../../../shared/workspace-layout/workspace-layout-stream-frames'
import '../../../../../shared/workspace-layout/stable-pane-id'
import { GIT_KEY } from '../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../../../app-shell/startup-window-view.test-fixture'
import { buildWorkspaceSessionPayload } from '../../../lib/workspace/persistence/workspace-session'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { endLayoutFramePositions } from './layout-frame-position'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from '../testing/workspace-layout-frame-apply-check.test-fixture'
import { mainLayoutFrameSender } from '../testing/main-loaded-layout-frames.test-fixture'

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type Call = {
  command: { type: string; tabId?: string; title?: string; renames?: { title: string }[] }
  answer: (r: LayoutApplyReply) => void
  fail: (error: Error) => void
}
const effects = vi.hoisted(() => ({
  graphSync: vi.fn(),
  mirrorViewMode: vi.fn(),
  chatToggled: vi.fn()
}))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scheduleRuntimeGraphSync: effects.graphSync
}))
vi.mock('@/store/slices/tabs/tabs-host-mirroring', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mirrorTabViewModeToHost: effects.mirrorViewMode
}))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitNativeChatToggled: effects.chatToggled
}))

const rpc = vi.hoisted((): { calls: Call[] } => ({ calls: [] }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (_target: unknown, _method: string, params: { command: { type: string } }) =>
    new Promise<LayoutApplyReply>((answer, fail) =>
      rpc.calls.push({ command: params.command, answer, fail })
    )
}))

type StreamDouble = {
  onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null
  onPosition: ((seq: number) => void) | null
}
const stream = vi.hoisted((): StreamDouble => ({ onFrame: null, onPosition: null }))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
    _onStatus: unknown,
    onPosition: (seq: number) => void
  ) => {
    stream.onFrame = onFrame
    stream.onPosition = onPosition
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

function publishedOf(session: WorkspaceSessionState): PublishedWorkspaceLayout {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local')
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let seq = 0
let frames = mainLayoutFrameSender()
/** A frame main sent before it had the window's change: another tab got renamed. */
function sendStaleFrame(layout: PublishedWorkspaceLayout): void {
  const stale = structuredClone(layout)
  stale.tabs.find((tab) => tab.id === 'tab-unbound')!.customTitle = `renamed ${++seq}`
  stream.onFrame!(frames.records(GIT_KEY, stale, seq))
  stream.onPosition!(seq)
}

async function boot() {
  const store = createTestStore()
  const session = localDesktopSession()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const before = publishedOf(session)
  frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot({ [GIT_KEY]: before }, ++seq))
  stream.onPosition!(seq)
  sync.start()
  await settle()
  const answer = async (
    index: number,
    reply: LayoutApplyReply = okReply,
    mainChange: (layout: PublishedWorkspaceLayout) => void = () => {}
  ): Promise<void> => {
    const frame = publishedOf(buildWorkspaceSessionPayload(store.getState()))
    mainChange(frame)
    seq += 1
    stream.onFrame!(frames.records(GIT_KEY, frame, seq))
    stream.onPosition!(seq)
    rpc.calls[index]!.answer({ ...reply, frameSeq: seq })
    await settle()
    await settle()
  }
  return { store, sync, before, answer }
}

const okReply: LayoutApplyReply = { ok: true, result: {} }

const tabBar = (store: ReturnType<typeof createTestStore>) =>
  store.getState().unifiedTabsByWorktree[GIT_KEY]!.map((tab) => tab.id)
const groupOrder = (store: ReturnType<typeof createTestStore>, groupId: string) =>
  store.getState().groupsByWorktree[GIT_KEY]!.find((group) => group.id === groupId)?.tabOrder

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  rpc.calls = []
  vi.clearAllMocks()
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('a tab the window drew, closed or moved, with a frame from before main had it', () => {
  it('keeps a just-closed terminal tab closed', async () => {
    const { store, sync, before, answer } = await boot()
    store.getState().closeTab('tab-unbound')
    const close = rpc.calls.findIndex((call) => call.command.type === 'closeTabs')
    expect(close).toBeGreaterThanOrEqual(0)

    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).not.toContain('tab-unbound')
    expect(groupOrder(store, 'group-b')).not.toContain('tab-unbound')
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((row) => row.id)).not.toContain(
      'tab-unbound'
    )

    await answer(close)
    expect(tabBar(store)).not.toContain('tab-unbound')
    sync.close()
  })

  it.each([
    ['refuses it', (call: Call) => call.answer({ ok: false, code: 'wsl_move_in_progress' })],
    ['throws', (call: Call) => call.fail(new Error('layout_store_unavailable'))]
  ])('removes a just-created terminal tab, stopping it, when main %s', async (_case, refuse) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, sync, before } = await boot()
    // Why: spied before the create, whose start mark publishes a new state after the tab's.
    const closeTab = vi.spyOn(store.getState(), 'closeTab')
    const tab = store.getState().createTab(GIT_KEY)
    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).toContain(tab.id)

    refuse(rpc.calls[0]!)
    await settle()
    await settle()
    expect(closeTab).toHaveBeenCalledWith(tab.id, { reason: 'cleanup' })
    expect(tabBar(store)).not.toContain(tab.id)
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((row) => row.id)).not.toContain(tab.id)
    expect(store.getState().terminalLayoutsByTabId[tab.id]).toBeUndefined()
    sync.close()
  })
})
