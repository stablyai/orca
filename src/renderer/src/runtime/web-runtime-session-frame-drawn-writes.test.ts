import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab
} from './web-runtime-session-tab-lifecycle'
import { closeWebRuntimeTerminal, updateWebRuntimePaneLayout } from './web-runtime-terminal-actions'
import {
  resetWebSessionCloseReplaysForTests,
  takeDueWebSessionCloseReplays
} from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from './paired-terminal-tab-close-intent-store'
import { createPairedTerminalTabCloseIntentTestStore } from '../store/terminals/paired-terminal-tab-close-intent.test-fixture'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import {
  resetFrameDrawnServerWorkspacesForTests,
  setFrameDrawnServerWorkspaces
} from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { ENVIRONMENT_ID, WORKTREE_ID } from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  redraw: vi.fn((_environmentId: string, _worktreeId: string) => true)
}))

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../store', () => ({
  useAppStore: { getState: mocks.getState, setState: mocks.setState, subscribe: mocks.subscribe }
}))
vi.mock('../lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => ENVIRONMENT_ID
}))
vi.mock('./server-layout-apply-routes', () => ({ redrawServerLayoutWorkspace: mocks.redraw }))
vi.mock('./web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: () => 0
}))
vi.mock('./web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/tracking-decisions', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackingDecisions>()),
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: () => () => {}
}))
vi.mock('./web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: () => null
}))

const OWNER = { environmentId: ENVIRONMENT_ID }
const TAB = toWebTerminalSurfaceTabId('host-tab-1')
const LIST = { id: 'list', ok: true, result: { worktree: WORKTREE_ID, tabs: [] } }

function answering(...answers: unknown[]) {
  const call = vi.fn(async (args: { method: string }) => {
    if (args.method === 'session.tabs.list') {
      return LIST
    }
    const next = answers.shift()
    if (next instanceof Error) {
      throw next
    }
    return next ?? { id: 'call', ok: true, result: {} }
  })
  stubRuntimeEnvironmentBridge({ call })
  return call
}

const refusal = (code: string) => ({ id: 'call', ok: false, error: { code, message: code } })
const sentMethods = (call: ReturnType<typeof answering>) =>
  call.mock.calls.map(([args]) => args.method).filter((method) => method !== 'session.tabs.list')

function frameDrawn(drawn: boolean) {
  setFrameDrawnServerWorkspaces(ENVIRONMENT_ID, drawn ? new Set([WORKTREE_ID]) : new Set())
}

beforeEach(() => {
  const intents = createPairedTerminalTabCloseIntentTestStore()
  mocks.getState.mockImplementation(() => ({
    settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    activeGroupIdByWorktree: {},
    ...intents.getState()
  }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  resetWebSessionCloseReplaysForTests()
  resetWebSessionFocusIntentForTests()
  resetFrameDrawnServerWorkspacesForTests()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const closePending = () =>
  isWebSessionCloseIntentPending(OWNER, WORKTREE_ID, 'host-tab-1', Date.now())

describe('a desktop close of a frame-drawn server tab', () => {
  it('reaches the server as session.tabs.close under its id, and keeps no mirror close intent', async () => {
    frameDrawn(true)
    const call = answering()
    const closing = closeWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: TAB,
      environmentId: ENVIRONMENT_ID,
      reason: 'user'
    })
    expect(closePending()).toBe(false)
    await expect(closing).resolves.toBe('applied')
    expect(call.mock.calls[0]![0]).toMatchObject({
      method: 'session.tabs.close',
      params: { tabId: 'host-tab-1', reason: 'user' }
    })
    expect(sentMethods(call)).not.toContain('layout.apply')
    expect(mocks.redraw).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'a pinned tab’s refusal', answer: refusal('terminal_tab_pinned') },
    {
      name: 'a refused result',
      answer: { id: 'call', ok: true, result: { refused: true, refusalReason: 'retirement-owner' } }
    }
  ])('redraws from the server’s frames on $name', async ({ answer }) => {
    frameDrawn(true)
    answering(answer)
    await closeWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: TAB,
      environmentId: ENVIRONMENT_ID,
      reason: 'user'
    })
    expect(mocks.redraw).toHaveBeenCalledWith(ENVIRONMENT_ID, WORKTREE_ID)
  })

  it('holds a close that never reached the server for replay, and does not redraw it', async () => {
    frameDrawn(true)
    answering(refusal('runtime_unavailable'))
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: TAB,
        environmentId: ENVIRONMENT_ID,
        reason: 'user'
      })
    ).resolves.toBe('failed')
    expect(mocks.redraw).not.toHaveBeenCalled()
    // The next session.tabs receipt resends it, as for a mirror-drawn workspace.
    const held = takeDueWebSessionCloseReplays(
      appPairedTerminalTabCloseIntentStore,
      ENVIRONMENT_ID,
      WORKTREE_ID,
      new Set(['host-tab-1'])
    )
    expect(held.map((replay) => replay.hostTabIds)).toEqual([['host-tab-1']])
  })

  it('keeps today’s close intent and no redraw for a server without layout intents', async () => {
    frameDrawn(false)
    answering(refusal('terminal_tab_pinned'))
    const closing = closeWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: TAB,
      environmentId: ENVIRONMENT_ID,
      reason: 'user'
    })
    expect(closePending()).toBe(true)
    await closing
    expect(mocks.redraw).not.toHaveBeenCalled()
  })
})

describe('a desktop activation of a frame-drawn server tab', () => {
  it('records the mirror’s focus intent only for a server without layout intents', async () => {
    frameDrawn(true)
    answering()
    await activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: TAB,
      environmentId: ENVIRONMENT_ID
    })
    expect(peekWebSessionFocusIntent(OWNER, WORKTREE_ID)).toBeNull()

    frameDrawn(false)
    // The mirror's snapshot apply consumes the intent; this answer never comes, so it stays.
    stubRuntimeEnvironmentBridge({ call: vi.fn(() => new Promise(() => {})) })
    void activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: TAB,
      environmentId: ENVIRONMENT_ID
    })
    await vi.waitFor(() =>
      expect(peekWebSessionFocusIntent(OWNER, WORKTREE_ID)?.hostTabId).toBe('host-tab-1')
    )
  })
})

describe('a desktop pane close of a frame-drawn server pane', () => {
  const PTY = `remote:${ENVIRONMENT_ID}@@terminal-1`

  it('goes as terminal.close, and redraws from the frames when the server refuses it', async () => {
    frameDrawn(true)
    const call = answering(refusal('terminal_handle_stale'))
    expect(closeWebRuntimeTerminal(PTY, WORKTREE_ID)).toBe(true)
    await vi.waitFor(() => expect(mocks.redraw).toHaveBeenCalledWith(ENVIRONMENT_ID, WORKTREE_ID))
    expect(sentMethods(call)).toEqual(['terminal.close'])
  })

  it('does not redraw a pane close the server took', async () => {
    frameDrawn(true)
    const call = answering({ id: 'call', ok: true, result: { close: {} } })
    closeWebRuntimeTerminal(PTY, WORKTREE_ID)
    await vi.waitFor(() => expect(call).toHaveBeenCalled())
    await Promise.resolve()
    expect(mocks.redraw).not.toHaveBeenCalled()
  })
})

describe('a desktop pane layout push for a frame-drawn server tab', () => {
  const layout = {
    worktreeId: WORKTREE_ID,
    tabId: TAB,
    root: { type: 'leaf' as const, leafId: 'leaf-1' },
    expandedLeafId: null
  }

  it('sends no geometry, which goes as layout.apply intents, only a pane rename', async () => {
    frameDrawn(true)
    const call = answering()
    await expect(updateWebRuntimePaneLayout(layout)).resolves.toBe(true)
    expect(sentMethods(call)).toEqual([])

    await updateWebRuntimePaneLayout({
      ...layout,
      titlesByLeafId: { 'leaf-1': 'logs' },
      renamedLeafIds: ['leaf-1']
    })
    expect(sentMethods(call)).toEqual(['session.tabs.updatePaneLayout'])
  })

  it('pushes geometry as today for a server without layout intents', async () => {
    frameDrawn(false)
    const call = answering()
    await updateWebRuntimePaneLayout(layout)
    expect(sentMethods(call)).toEqual(['session.tabs.updatePaneLayout'])
  })
})
