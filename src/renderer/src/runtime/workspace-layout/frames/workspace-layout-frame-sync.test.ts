import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { localDesktopSession } from '../../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { GIT_KEY } from '../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import '../../../store/slices/editor/file-ids/editor-file-ids'
import { bootWindowFromPartitions } from '../../../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { afterLayoutFrame, endLayoutFramePositions } from './layout-frame-position'
import { requestTabPaneTreeRedraw } from '../intents/layout-owner-pane-tree-holds'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import {
  mainLayoutFrameSender,
  mainLoadedLayouts
} from '../testing/main-loaded-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from '../testing/workspace-layout-frame-apply-check.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type StreamDouble = {
  onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null
  onStatus: ((status: { state: string }) => void) | null
  onPosition: ((seq: number) => void) | null
  close: () => void
}
const stream = vi.hoisted((): StreamDouble => ({
  onFrame: null,
  onStatus: null,
  onPosition: null,
  close: () => {}
}))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
    onStatus: (status: { state: string }) => void,
    onPosition: (seq: number) => void
  ) => {
    stream.onFrame = onFrame
    stream.onStatus = onStatus
    stream.onPosition = onPosition
    return { close: stream.close }
  }
}))

createStoreSessionMockApi()

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function bootWithFrames(hostId: ExecutionHostId, session: WorkspaceSessionState) {
  const store = createTestStore()
  await bootWindowFromPartitions(store, [{ hostId, session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const layouts = mainLoadedLayouts(hostId, session)
  const frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot(layouts))
  return { store, sync, layouts, frames }
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('the window drawn from layout frames', () => {
  it('runs a reply waiting on a frame after the store shows it, and every waiter when the stream ends', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    stream.onFrame!(frames.records(GIT_KEY, layouts[GIT_KEY]!, 1))
    stream.onPosition!(1)
    await flushMicrotasks()
    const shellTitle = () =>
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!.customTitle
    const seen: (string | null | undefined)[] = []
    afterLayoutFrame(2, () => seen.push(shellTitle()))
    expect(seen).toEqual([])

    const renamed = structuredClone(layouts[GIT_KEY]!)
    renamed.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'renamed'
    stream.onFrame!(frames.records(GIT_KEY, renamed, 2))
    stream.onPosition!(2)
    await flushMicrotasks()
    expect(seen).toEqual(['renamed'])

    const released = vi.fn()
    afterLayoutFrame(9, released)
    stream.onStatus!({ state: 'lost' })
    expect(released).toHaveBeenCalledTimes(1)
    // A position counted before the end but noted after it does not reopen the wait.
    stream.onPosition!(4)
    await flushMicrotasks()
    const later = vi.fn()
    afterLayoutFrame(10, later)
    expect(later).toHaveBeenCalledTimes(1)
    sync.close()
  })

  it('keeps the window’s own pane trees once the stream has ended', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    await flushMicrotasks()
    // A frame still queued when the stream ends.
    stream.onFrame!(frames.records(GIT_KEY, structuredClone(layouts[GIT_KEY]!)))
    stream.onStatus!({ state: 'lost' })
    const drawn = { type: 'leaf' as const, leafId: 'drawn-by-the-window' }
    store.setState({
      terminalLayoutsByTabId: {
        ...store.getState().terminalLayoutsByTabId,
        'tab-shell': { ...store.getState().terminalLayoutsByTabId['tab-shell']!, root: drawn }
      }
    })

    requestTabPaneTreeRedraw('tab-shell')
    await flushMicrotasks()
    expect(store.getState().terminalLayoutsByTabId['tab-shell']!.root).toEqual(drawn)

    sync.close()
  })
})
