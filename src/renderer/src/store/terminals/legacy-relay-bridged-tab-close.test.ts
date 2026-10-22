import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTabRetirementPlan } from '../slices/terminal-tab-retirement'

const PTY = 'ssh:ssh-box@@pty-1'
const TAB = 'web-terminal-tab-1'

const api = vi.hoisted(() => {
  let release: () => void = () => {}
  const listed = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    close: vi.fn(async () => ({ status: 'requested' })),
    // Main answers the first listing late, after the close already started.
    listPanes: vi.fn(async () => {
      await listed
      return [{ ptyId: 'ssh:ssh-box@@pty-1', targetId: 'ssh-box', tabId: 'tab-1', state: 'live' }]
    }),
    release: () => release()
  }
})

vi.stubGlobal('window', {
  api: {
    legacyRelayBridge: { listPanes: api.listPanes, close: api.close, onPanes: () => () => {} }
  }
})

const { stopLegacyRelayBridgedShellsForTab } = await import('./legacy-relay-bridged-tab-close')

function plan(overrides: Partial<TerminalTabRetirementPlan> = {}): TerminalTabRetirementPlan {
  return {
    tabId: TAB,
    worktreeId: 'wt-1',
    ptyIds: [],
    localOrSshPtyIds: [],
    runtimeTerminals: [],
    cleanupOnlyPtyIds: [],
    sharedPtyIds: [],
    unroutablePtyIds: [],
    ...overrides
  }
}

function state(otherTabPtyId: string | null = null) {
  return {
    tabsByWorktree: {
      'wt-1': [
        { id: TAB, ptyId: PTY },
        ...(otherTabPtyId ? [{ id: 'moved-to', ptyId: otherTabPtyId }] : [])
      ]
    },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {}
  }
}

beforeEach(() => {
  api.close.mockClear()
})

describe('closing a tab whose shell an older relay still runs', () => {
  it('stops that shell, waiting for main’s first pane list rather than reading it empty', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close reads only the tab and pty maps this fixture fills.
    const closing = stopLegacyRelayBridgedShellsForTab(state() as never, TAB, plan())
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(api.close).not.toHaveBeenCalled()
    api.release()
    await closing
    expect(api.close).toHaveBeenCalledWith({ ptyId: PTY })
  })

  it('never stops a shell another tab now shows, or one the plan says is shared', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    await stopLegacyRelayBridgedShellsForTab(state(PTY) as never, TAB, plan())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    await stopLegacyRelayBridgedShellsForTab(state() as never, TAB, plan({ sharedPtyIds: [PTY] }))
    expect(api.close).not.toHaveBeenCalled()
  })
})
