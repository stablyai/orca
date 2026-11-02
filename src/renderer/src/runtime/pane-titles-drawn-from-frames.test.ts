// Main applies renames and frames draw titles without a second window write. Shared transport checks each flush against full-build behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { useAppStore } from '@/store'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { leaf } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { applyRuntimePaneTitle } from '../hooks/ipc-events/terminal-pane-title-ipc-bridge'
import { layoutApplyTestTransport } from './layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from './main-loaded-layout-frames.test-fixture'
import { endLayoutFramePositions } from './layout-frame-position'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// Main's answer to the window's layout commands and its frames, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
// The test opens its own stream: boot's document-long one would outlive the test's transport.
vi.mock('./workspace-layout-frame-sync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showStartupLayoutFrames: () => {}
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const settle = async (): Promise<void> => {
  await layoutApplyTestTransport.settle()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const dispatchEvent = vi.fn()
let close = (): void => {}

beforeEach(async () => {
  dispatchEvent.mockReset()
  vi.stubGlobal('window', { ...globalThis.window, dispatchEvent })
  layoutApplyTestTransport.reset()
  const session = localDesktopSession()
  layoutApplyTestTransport.useMainModel(loadMainLayoutModel('local', session))
  layoutApplyTestTransport.answerWith('apply')
  await bootWindowFromPartitions(useAppStore, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  sync.start()
  await settle()
  close = () => sync.close()
})

afterEach(() => {
  close()
  endLayoutFramePositions()
  vi.unstubAllGlobals()
})

const titles = () => useAppStore.getState().terminalLayoutsByTabId['tab-shell']?.titlesByLeafId

/** Store writes to the tabs' pane layouts: main's frame is one, a window re-apply another. */
function layoutWrites(): { count: () => number; stop: () => void } {
  let count = 0
  const stop = useAppStore.subscribe((state, previous) => {
    if (state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId) {
      count += 1
    }
  })
  return { count: () => count, stop }
}

describe('a pane title drawn from main’s frame', () => {
  it('names a pane from main’s frame alone', async () => {
    const writes = layoutWrites()
    applyRuntimePaneTitle({ tabId: 'tab-shell', leafId: leaf(1), title: ' REVIEWER ' })
    await settle()
    writes.stop()

    expect(layoutApplyTestTransport.sentOfType('renamePane')).toEqual([
      expect.objectContaining({ tabId: 'tab-shell', leafId: leaf(1), title: 'REVIEWER' })
    ])
    expect(titles()).toEqual({ [leaf(1)]: 'REVIEWER', [leaf(2)]: 'server' })
    expect(writes.count()).toBe(1)
    // A mounted pane follows the layout's titles (use-host-pane-title-sync), not an event.
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('clears a pane’s name from main’s frame alone', async () => {
    const writes = layoutWrites()
    applyRuntimePaneTitle({ tabId: 'tab-shell', leafId: leaf(2), title: null })
    await settle()
    writes.stop()

    expect(titles()).toBeUndefined()
    expect(writes.count()).toBe(1)
  })
})
