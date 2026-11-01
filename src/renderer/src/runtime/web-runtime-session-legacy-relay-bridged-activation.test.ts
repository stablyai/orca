// COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
// The managed server starts a shell for any unmaterialized pane a client activates. A pane an older
// relay still runs is served by the bridge, so activating it would leave a second, unseen shell.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyRelayBridgedPane } from '../../../shared/legacy-relay-bridge-contract'
import { activateWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'
import {
  peekWebSessionFocusIntent,
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { ENVIRONMENT_ID, WORKTREE_ID } from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null)
}))

vi.mock('../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('./web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

const bridged: LegacyRelayBridgedPane = {
  ptyId: 'ssh:target-1@@pty-1',
  targetId: 'target-1',
  tabId: 'relay-tab',
  leafId: 'relay-leaf',
  state: 'unverifiable'
}

function stubWindow(call: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call },
      legacyRelayBridge: {
        listPanes: () => Promise.resolve([bridged]),
        onPanes: (listener: (panes: LegacyRelayBridgedPane[]) => void) => {
          listener([bridged])
          return () => {}
        }
      }
    }
  })
}

describe('activating a pane the legacy relay bridge serves', () => {
  beforeEach(() => {
    mocks.getState.mockReturnValue({ settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID } })
  })

  afterEach(() => {
    resetWebSessionFocusIntentForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('never asks the managed server to start a shell for it', async () => {
    const call = vi.fn().mockResolvedValue({ id: 'activate', ok: true, result: {} })
    stubWindow(call)

    await expect(
      activateWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: toWebTerminalSurfaceTabId('relay-tab::relay-leaf'),
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(true)

    expect(call).not.toHaveBeenCalled()
  })

  it("drops an earlier tab's pending focus so its late snapshot cannot pull focus back", async () => {
    stubWindow(vi.fn())
    const owner = { environmentId: ENVIRONMENT_ID }
    recordWebSessionFocusIntent(owner, WORKTREE_ID, 'orcad-tab::leaf')

    await activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: toWebTerminalSurfaceTabId('relay-tab::relay-leaf'),
      environmentId: ENVIRONMENT_ID
    })

    expect(peekWebSessionFocusIntent(owner, WORKTREE_ID)).toBeNull()
  })

  it('reads a click on the whole mirrored tab as the pane it shows', async () => {
    const call = vi.fn().mockResolvedValue({ id: 'activate', ok: true, result: {} })
    stubWindow(call)
    const tabId = toWebTerminalSurfaceTabId('relay-tab')
    const showing = (activeLeafId: string | undefined): void => {
      mocks.getState.mockReturnValue({
        settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
        terminalLayoutsByTabId: activeLeafId ? { [tabId]: { activeLeafId } } : {}
      })
    }

    showing('relay-leaf')
    await activateWebRuntimeSessionTab({ worktreeId: WORKTREE_ID, tabId })
    // Without a pane on screen the server would pick one itself, which may be the bridged one.
    showing(undefined)
    await activateWebRuntimeSessionTab({ worktreeId: WORKTREE_ID, tabId })
    expect(call).not.toHaveBeenCalled()

    // A sibling pane on screen is aimed at by leaf, so the server never picks the bridged one.
    showing('orcad-leaf')
    await activateWebRuntimeSessionTab({ worktreeId: WORKTREE_ID, tabId })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.activate',
        params: expect.objectContaining({ tabId: 'relay-tab', leafId: 'orcad-leaf' })
      })
    )
  })
})
