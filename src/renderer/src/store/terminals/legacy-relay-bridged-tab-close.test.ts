import { expect, it, vi } from 'vitest'
import type {
  TerminalTabRetirementPlan,
  TerminalTabRetirementState
} from './terminal-tab-retirement'
import { makeTab } from './terminal-tab.test-fixture'
import { makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'

const listing = vi.hoisted(() => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  return { pending, resolve }
})
vi.mock('@/components/terminal-pane/pty-transport/legacy-relay/legacy-relay-bridge-panes', () => ({
  legacyRelayBridgedPanesListed: () => listing.pending,
  legacyRelayBridgedPtyIdsForClosingTab: () => [
    'lease-1',
    'lease-2',
    'lease-3',
    'lease-4',
    'lease-5'
  ]
}))
import { stopLegacyRelayBridgedShellsForTab } from './legacy-relay-bridged-tab-close'

it('checks late moves, duplicate rows and dispatch reentry before each bridge lease close', async () => {
  let state: TerminalTabRetirementState = {
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {}
  }
  const close = vi.fn(async ({ ptyId }: { ptyId: string }) => {
    if (ptyId === 'lease-2') {
      state = {
        ...state,
        tabsByWorktree: {},
        unifiedTabsByWorktree: {
          wt: [
            makeUnifiedTab({ id: 'wrapper', entityId: 'moved', worktreeId: 'wt', groupId: 'group' })
          ]
        },
        pendingReconnectPtyIdByTabId: { moved: 'lease-3' }
      }
    }
  })
  vi.stubGlobal('window', { api: { legacyRelayBridge: { close } } })
  const plan: TerminalTabRetirementPlan = {
    tabId: 'closing',
    worktreeId: null,
    ptyIds: [],
    localOrSshPtyIds: [],
    runtimeTerminals: [],
    cleanupOnlyPtyIds: [],
    sharedPtyIds: ['lease-5'],
    unroutablePtyIds: []
  }
  try {
    const pending = stopLegacyRelayBridgedShellsForTab(() => state, 'closing', plan)
    state = {
      ...state,
      tabsByWorktree: {
        wt: [
          makeTab({ id: 'holder', worktreeId: 'wt', ptyId: 'lease-1' }),
          makeTab({ id: 'holder', worktreeId: 'wt', ptyId: 'different' }),
          makeTab({ id: 'removed-later', worktreeId: 'wt', ptyId: 'lease-4' })
        ]
      }
    }
    listing.resolve()
    await pending
    expect(close.mock.calls).toEqual([[{ ptyId: 'lease-2' }], [{ ptyId: 'lease-4' }]])
  } finally {
    vi.unstubAllGlobals()
  }
})
