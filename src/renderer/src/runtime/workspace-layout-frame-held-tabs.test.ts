import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import { withLayoutOwnerTabProps } from '@/components/tab-bar/tab-bar-layout-owner-props'
import { endLayoutFramePositions } from './layout-frame-position'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import {
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph/sync-key'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
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
vi.mock('@/runtime/sync-runtime-graph', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scheduleRuntimeGraphSync: effects.graphSync
}))
vi.mock('@/store/slices/tabs/tabs-host-mirroring', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mirrorTabViewModeToHost: effects.mirrorViewMode
}))
vi.mock('@/lib/native-chat-telemetry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitNativeChatToggled: effects.chatToggled
}))

const rpc = vi.hoisted((): { calls: Call[] } => ({ calls: [] }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
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

/** Counts the store writes that change one slice: main's frame is one, a window re-apply another. */
function writesOf<T>(
  store: ReturnType<typeof createTestStore>,
  pick: (state: ReturnType<ReturnType<typeof createTestStore>['getState']>) => T
) {
  let count = 0
  const stop = store.subscribe((state, previous) => {
    if (pick(state) !== pick(previous)) {
      count += 1
    }
  })
  return { count: () => count, stop }
}

const tabBar = (store: ReturnType<typeof createTestStore>) =>
  store.getState().unifiedTabsByWorktree[GIT_KEY]!.map((tab) => tab.id)
const groupOrder = (store: ReturnType<typeof createTestStore>, groupId: string) =>
  store.getState().groupsByWorktree[GIT_KEY]!.find((group) => group.id === groupId)?.tabOrder

/** Draws a tab as the window's open does, before its recorder tells main. */
function drawTab(
  store: ReturnType<typeof createTestStore>,
  tab: Partial<Tab> & { id: string }
): Tab {
  const drawn: Tab = {
    entityId: tab.id,
    groupId: 'group-b',
    worktreeId: GIT_KEY,
    contentType: 'simulator',
    label: tab.id,
    customLabel: null,
    color: null,
    sortOrder: 9,
    createdAt: 1_700_000_900_000,
    ...tab
  }
  const state = store.getState()
  store.setState({
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [GIT_KEY]: [...state.unifiedTabsByWorktree[GIT_KEY]!, drawn]
    },
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [GIT_KEY]: state.groupsByWorktree[GIT_KEY]!.map((group) =>
        group.id === drawn.groupId ? { ...group, tabOrder: [...group.tabOrder, drawn.id] } : group
      )
    }
  })
  return drawn
}

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
  it('keeps a just-created terminal tab, then shows main’s copy', async () => {
    const { store, sync, before, answer } = await boot()
    const tab = store.getState().createTab(GIT_KEY)
    expect(rpc.calls[0]!.command).toMatchObject({ type: 'createTerminalTab', tabId: tab.id })

    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).toContain(tab.id)
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((row) => row.id)).toContain(tab.id)
    expect(store.getState().terminalLayoutsByTabId[tab.id]).toBeDefined()

    await answer(0)
    expect(tabBar(store)).toContain(tab.id)
    sync.close()
  })

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

  // Browser, chat and simulator opens draw from main's frame alone: content-tabs-from-main-frames.test.ts.

  it('keeps a reorder the window made, and main’s order for the rest', async () => {
    const { store, sync, before, answer } = await boot()
    const order = groupOrder(store, 'group-a')!
    const reordered = order.toReversed()
    store.getState().reorderUnifiedTabs('group-a', reordered)
    const moves = rpc.calls.filter((call) => call.command.type === 'moveTab')
    expect(moves.length).toBeGreaterThan(0)

    sendStaleFrame(before)
    await settle()
    expect(groupOrder(store, 'group-a')).toEqual(reordered)

    for (let index = 0; index < rpc.calls.length; index += 1) {
      await answer(index)
    }
    expect(groupOrder(store, 'group-a')).toEqual(reordered)
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

describe('a change main applies first, with frames flowing', () => {
  const callsOf = (type: string) => rpc.calls.filter((call) => call.command.type === type)

  it('pins a preview tab and promotes it once; only main’s frame ends the preview', async () => {
    const { store, sync, answer } = await boot()
    const file = {
      ...store.getState().openFiles[0]!,
      id: '/Users/dev/orca/src/peek.ts',
      filePath: '/Users/dev/orca/src/peek.ts',
      relativePath: 'src/peek.ts',
      isPreview: true
    }
    store.setState({ openFiles: [...store.getState().openFiles, file] })
    const tab = drawTab(store, {
      id: 'editor:peek',
      entityId: file.id,
      contentType: 'editor',
      isPreview: true
    })
    seq += 1
    stream.onFrame!(
      frames.records(GIT_KEY, publishedOf(buildWorkspaceSessionPayload(store.getState())), seq)
    )
    stream.onPosition!(seq)
    await settle()
    const entry = () =>
      store.getState().unifiedTabsByWorktree[GIT_KEY]!.find((item) => item.id === tab.id)!

    const windowPin = vi.fn((tabId: string) => store.getState().pinFile(file.id, tabId))
    withLayoutOwnerTabProps(
      {
        togglePinned: (item) => windowPin(item.unifiedTabId),
        makePreviewFilePermanent: (fileId, tabId) =>
          store.getState().makePreviewFilePermanent(fileId, tabId)
      },
      () => GIT_KEY
    ).togglePinned({ unifiedTabId: tab.id, isPinned: false, type: 'editor', data: { id: file.id } })
    const pin = rpc.calls.length - 1
    expect(rpc.calls[pin]!.command).toMatchObject({ type: 'setTabProps', isPinned: true })
    await answer(pin, okReply, (layout) => {
      layout.tabs.find((item) => item.id === tab.id)!.isPinned = true
    })
    expect(windowPin).not.toHaveBeenCalled()
    expect(callsOf('promotePreviewTab')).toHaveLength(1)
    expect(entry()).toMatchObject({ isPinned: true, isPreview: true })

    await answer(rpc.calls.indexOf(callsOf('promotePreviewTab')[0]!), okReply, (layout) => {
      delete layout.tabs.find((item) => item.id === tab.id)!.isPreview
    })
    expect(entry()).toMatchObject({ isPinned: true })
    expect(entry().isPreview).toBeFalsy()
    expect(callsOf('promotePreviewTab')).toHaveLength(1)
    sync.close()
  })

  it('runs a view toggle’s bookkeeping once, after main’s frame shows the toggle', async () => {
    const { store, sync, answer } = await boot()
    store.getState().toggleTabViewMode('tab-agent')
    const toggle = rpc.calls.length - 1
    expect(rpc.calls[toggle]!.command).toMatchObject({ type: 'setTabProps', viewMode: 'terminal' })
    const writes = writesOf(store, (state) => state.unifiedTabsByWorktree)

    await answer(toggle, okReply, (layout) => {
      layout.tabs.find((item) => item.id === 'tab-agent')!.viewMode = 'terminal'
    })
    writes.stop()
    expect(writes.count()).toBe(1)
    const agent = () =>
      store.getState().unifiedTabsByWorktree[GIT_KEY]!.find((item) => item.id === 'tab-agent')!
    expect(agent().viewMode).toBe('terminal')
    expect(effects.mirrorViewMode).not.toHaveBeenCalled()
    expect(effects.chatToggled).toHaveBeenCalledTimes(1)
    expect(effects.chatToggled).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'chat', to: 'terminal' })
    )

    // The answered send is settled: the next toggle flips from what is shown, back to chat.
    store.getState().toggleTabViewMode('tab-agent')
    expect(rpc.calls.at(-1)!.command).toMatchObject({ type: 'setTabProps', viewMode: 'chat' })
    sync.close()
  })

  it('sends main no generated title, and shows the one main derived from its frame alone', async () => {
    const { store, sync } = await boot()
    store.setState({ settings: { ...store.getState().settings!, tabAutoGenerateTitle: true } })
    const leafId = store.getState().terminalLayoutsByTabId['tab-unbound']!.activeLeafId!
    const paneKey = makePaneKey('tab-unbound', leafId)
    const renames = () => callsOf('renameTabs')
    store.getState().setGeneratedTabTitleFromAgentPrompt(paneKey, 'Refactor the auth middleware')
    store.getState().setGeneratedTabTitleFromAgentPrompt(paneKey, 'Fix the flaky login test', {
      replaceExistingGeneratedTitle: true
    })
    expect(renames()).toEqual([])

    const writes = writesOf(store, (state) => state.tabsByWorktree)
    const frame = publishedOf(buildWorkspaceSessionPayload(store.getState()))
    frame.tabs.find((item) => item.id === 'tab-unbound')!.generatedTitle = 'Refactor the auth'
    stream.onFrame!(frames.records(GIT_KEY, frame, ++seq))
    stream.onPosition!(seq)
    await settle()
    writes.stop()
    const row = store.getState().tabsByWorktree[GIT_KEY]!.find((item) => item.id === 'tab-unbound')!
    expect(row.generatedTitle).toBe('Refactor the auth')
    expect(writes.count()).toBe(1)
    expect(renames()).toEqual([])
    sync.close()
  })

  it('shows main’s rename from its frame alone, without the window writing it again', async () => {
    const { store, sync, answer } = await boot()
    store.getState().setTabCustomTitle('tab-unbound', 'Build')
    const rename = rpc.calls.length - 1
    const writes = writesOf(store, (state) => state.tabsByWorktree)
    const graphBefore = getRuntimeMobileSessionSyncKey(store.getState())

    await answer(rename, okReply, (layout) => {
      layout.tabs.find((item) => item.id === 'tab-unbound')!.customTitle = 'Build'
    })
    const row = store.getState().tabsByWorktree[GIT_KEY]!.find((item) => item.id === 'tab-unbound')!
    expect(row.customTitle).toBe('Build')
    expect(writes.count()).toBe(1)
    // The frame's write changes what the phone graph publishes, so useRuntimeGraphSync republishes.
    expect(
      runtimeMobileSessionSyncKeysEqual(
        getRuntimeMobileSessionSyncKey(store.getState()),
        graphBefore
      )
    ).toBe(false)
    writes.stop()
    sync.close()
  })

  it('shows main’s tab color from its frame alone, without the window writing it again', async () => {
    const { store, sync, answer } = await boot()
    store.getState().setTabColor('tab-unbound', '#ff0000')
    const color = rpc.calls.length - 1
    expect(rpc.calls[color]!.command).toMatchObject({ type: 'setTabProps', color: '#ff0000' })
    const writes = writesOf(store, (state) => state.tabsByWorktree)

    await answer(color, okReply, (layout) => {
      layout.tabs.find((item) => item.id === 'tab-unbound')!.color = '#ff0000'
    })
    const row = store.getState().tabsByWorktree[GIT_KEY]!.find((item) => item.id === 'tab-unbound')!
    expect(row.color).toBe('#ff0000')
    expect(writes.count()).toBe(1)
    writes.stop()
    sync.close()
  })
})
