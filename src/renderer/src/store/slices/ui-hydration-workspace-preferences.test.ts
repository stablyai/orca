import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorktreeCardModeProperties } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { AppState } from '../types'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mocks.sendNotesToActiveAgentSession.mockReset()
  mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

describe('createUISlice hydratePersistedUI', () => {
  it('does not restore the retired active-only filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showActiveOnly: true
      })
    )

    expect(store.getState().showActiveOnly).toBe(false)
  })

  it('restores the new hide-sleeping filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        hideSleepingWorkspaces: true
      })
    )

    expect(store.getState().showSleepingWorkspaces).toBe(false)
  })

  it('ignores legacy hidden-sleeping preference so existing users start with sleeping visible', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showSleepingWorkspaces: false
      })
    )

    expect(store.getState().showSleepingWorkspaces).toBe(true)
  })

  it('ignores the legacy show-inactive filter so existing users start with sleeping visible', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showSleepingWorkspaces: undefined,
        showInactiveWorkspaces: false
      })
    )

    expect(store.getState().showSleepingWorkspaces).toBe(true)
  })

  it('restores the hide-default-branch filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        hideDefaultBranchWorkspace: true
      })
    )

    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
  })

  it('restores selected card properties during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        worktreeCardProperties: ['inline-agents']
      })
    )

    expect(store.getState().worktreeCardProperties).toEqual(['status', 'unread', 'inline-agents'])
  })

  it('adds default-on status items once for older persisted UI', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        statusBarItems: ['claude', 'resource-usage'],
        _portsStatusBarDefaultAdded: false
      })
    )

    expect(store.getState().statusBarItems).toEqual([
      'claude',
      'resource-usage',
      'ports',
      'kimi',
      'minimax',
      'antigravity',
      'grok'
    ])
    expect(setUI).toHaveBeenCalledWith({
      statusBarItems: [
        'claude',
        'resource-usage',
        'ports',
        'kimi',
        'minimax',
        'antigravity',
        'grok'
      ],
      _portsStatusBarDefaultAdded: true,
      _kimiStatusBarDefaultAdded: true,
      _minimaxStatusBarDefaultAdded: true,
      _antigravityStatusBarDefaultAdded: true,
      _grokStatusBarDefaultAdded: true
    })
  })

  it('preserves user-hidden default-on status items after one-shot migrations ran', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        statusBarItems: ['claude', 'resource-usage'],
        _portsStatusBarDefaultAdded: true,
        _kimiStatusBarDefaultAdded: true,
        _minimaxStatusBarDefaultAdded: true,
        _antigravityStatusBarDefaultAdded: true,
        _grokStatusBarDefaultAdded: true
      })
    )

    expect(store.getState().statusBarItems).toEqual(['claude', 'resource-usage'])
    expect(setUI).not.toHaveBeenCalled()
  })

  it('persists and hydrates the usage percentage display preference', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setUsagePercentageDisplay('used')

    expect(store.getState().usagePercentageDisplay).toBe('used')
    // Why: adapting the control also permanently dismisses the one-time change notice.
    expect(setUI).toHaveBeenCalledWith({
      usagePercentageDisplay: 'used',
      usagePercentageDisplayChangeNoticeDismissed: true
    })
    expect(store.getState().usagePercentageDisplayChangeNoticeDismissed).toBe(true)

    store.getState().hydratePersistedUI(makePersistedUI({ usagePercentageDisplay: 'remaining' }))
    expect(store.getState().usagePercentageDisplay).toBe('remaining')
  })

  it('hydrates and dismisses the usage percentage display change notice', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ usagePercentageDisplayChangeNoticeDismissed: false }))
    expect(store.getState().usagePercentageDisplayChangeNoticeDismissed).toBe(false)

    store.getState().dismissUsagePercentageDisplayChangeNotice()
    expect(store.getState().usagePercentageDisplayChangeNoticeDismissed).toBe(true)
    expect(setUI).toHaveBeenCalledWith({ usagePercentageDisplayChangeNoticeDismissed: true })

    setUI.mockClear()
    store.getState().dismissUsagePercentageDisplayChangeNotice()
    expect(setUI).not.toHaveBeenCalled()
  })

  it('defaults invalid usage percentage display values to used', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        usagePercentageDisplay: 'left' as PersistedUIState['usagePercentageDisplay']
      })
    )

    expect(store.getState().usagePercentageDisplay).toBe('used')
  })

  it('persists and hydrates the status bar usage mode', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    expect(store.getState().statusBarUsageMode).toBe('verbose')

    store.getState().setStatusBarUsageMode('compact')

    expect(store.getState().statusBarUsageMode).toBe('compact')
    expect(setUI).toHaveBeenCalledWith({ statusBarUsageMode: 'compact' })

    store.getState().hydratePersistedUI(makePersistedUI({ statusBarUsageMode: 'verbose' }))
    expect(store.getState().statusBarUsageMode).toBe('verbose')
  })

  it('defaults invalid status bar usage modes to verbose', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        statusBarUsageMode: 'expanded' as PersistedUIState['statusBarUsageMode']
      })
    )

    expect(store.getState().statusBarUsageMode).toBe('verbose')
  })

  it('clamps persisted workspace board column width', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceBoardColumnWidth: 900
      })
    )

    expect(store.getState().workspaceBoardColumnWidth).toBe(520)
  })

  it('defaults workspace board task status sync off and persists changes', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    expect(store.getState().syncTaskStatusFromWorkspaceBoard).toBe(false)

    store.getState().hydratePersistedUI(
      makePersistedUI({
        syncTaskStatusFromWorkspaceBoard: true
      })
    )
    expect(store.getState().syncTaskStatusFromWorkspaceBoard).toBe(true)

    store.getState().setSyncTaskStatusFromWorkspaceBoard(false)

    expect(store.getState().syncTaskStatusFromWorkspaceBoard).toBe(false)
    expect(setUI).toHaveBeenCalledWith({ syncTaskStatusFromWorkspaceBoard: false })
  })

  it('hydrates a valid Kagi session link', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://kagi.com/search?token=secret&q=%s'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBe('https://kagi.com/search?token=secret')
  })

  it('hydrates and normalizes the default browser zoom level', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserDefaultZoomLevel: 1.26
      })
    )

    expect(store.getState().browserDefaultZoomLevel).toBe(1.5)
  })

  it('persists normalized default browser zoom changes', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setBrowserDefaultZoomLevel(10)

    expect(store.getState().browserDefaultZoomLevel).toBe(5)
    expect(setUI).toHaveBeenCalledWith({ browserDefaultZoomLevel: 5 })
  })

  it('drops an invalid Kagi session link during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://example.com/search?token=secret'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBeNull()
  })

  it('hydrates legacy sidekick persisted keys into pet state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        petVisible: undefined,
        petId: undefined,
        petSize: undefined,
        customPets: undefined,
        sidekickVisible: false,
        sidekickId: 'custom-pet',
        sidekickSize: 240,
        customSidekicks: [
          {
            id: 'custom-pet',
            label: 'Legacy pet',
            fileName: 'custom-pet.webp',
            mimeType: 'image/webp',
            kind: 'image'
          }
        ]
      })
    )

    expect(store.getState().petVisible).toBe(false)
    expect(store.getState().petId).toBe('custom-pet')
    expect(store.getState().petSize).toBe(240)
    expect(store.getState().customPets).toEqual([
      {
        id: 'custom-pet',
        label: 'Legacy pet',
        fileName: 'custom-pet.webp',
        mimeType: 'image/webp',
        kind: 'image'
      }
    ])
  })

  it('sanitizes task resume state field-by-field during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        taskResumeState: {
          githubMode: 'project',
          githubItemsPreset: 'invalid',
          githubItemsQuery: 42,
          linearPreset: 'completed',
          linearQuery: 'label:bug',
          jiraPreset: 'reported',
          jiraQuery: 99
        } as unknown as PersistedUIState['taskResumeState']
      })
    )

    expect(store.getState().taskResumeState).toEqual({
      githubMode: 'project',
      linearPreset: 'completed',
      linearQuery: 'label:bug',
      jiraPreset: 'reported'
    })
  })

  // Why: the Linear issue view is device-local now. A host that still holds one from
  // an older build must not reintroduce the key the strict ui.set schema rejects.
  it('ignores a stale host-persisted Linear issue view during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        taskResumeState: {
          linearQuery: 'label:bug',
          linearIssueView: { viewMode: 'board', groupBy: 'assignee' }
        } as unknown as PersistedUIState['taskResumeState']
      })
    )

    expect(store.getState().taskResumeState).toEqual({ linearQuery: 'label:bug' })
  })

  it('restores acknowledgedAgentsByPaneKey from persisted UI state', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: { 'tab-a:0': now, 'tab-b:1': now - 5_000 }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 5_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to an empty ack map when persisted UI omits acknowledgedAgentsByPaneKey', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI())

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is null', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          null as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is a string', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          'oops' as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is an array', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey: [
          'a',
          'b'
        ] as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('drops non-number / non-finite / non-positive entries from acknowledgedAgentsByPaneKey', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-a:0': now,
            'tab-b:1': now - 1000,
            'tab-c:2': 'not-a-number',
            'tab-d:3': Number.NaN,
            'tab-e:4': Number.POSITIVE_INFINITY,
            'tab-f:5': -1
          } as unknown as Record<string, number>
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 1000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes acknowledgedAgentsByPaneKey entries older than the 7-day TTL during hydration', () => {
    // HYDRATE_MAX_AGE_MS lives in src/renderer/src/store/slices/ui.ts and matches
    // the constant in src/main/agent-hooks/server.ts.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-recent:0': now,
            'tab-old:1': now - SEVEN_DAYS_MS - 1
          }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-recent:0': now
      })
    } finally {
      // The shared afterEach restores mocks/globals but not timers, so clean up
      // here to avoid leaking fake timers into subsequent tests.
      vi.useRealTimers()
    }
  })

  it('drops prototype-pollution keys from acknowledgedAgentsByPaneKey during hydration', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      const malicious: Record<string, number> = {}
      // Object.defineProperty so these land as own enumerable properties rather
      // than getting silently re-routed to Object.prototype by the JS engine.
      Object.defineProperty(malicious, '__proto__', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'constructor', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'prototype', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      malicious['tab-safe:0'] = now

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: malicious
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-safe:0': now
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges and persists partial task resume updates', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.setState({ taskResumeState: { githubMode: 'project', linearPreset: 'all' } })
    store.getState().setTaskResumeState({ githubItemsPreset: 'my-prs' })

    const expected = { githubMode: 'project', linearPreset: 'all', githubItemsPreset: 'my-prs' }
    expect(store.getState().taskResumeState).toEqual(expected)
    expect(setUI).toHaveBeenCalledWith({ taskResumeState: expected })
  })

  it('sets Default worktree card mode with matching settings and UI writes', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    const setSettings = vi.fn().mockResolvedValue({ compactWorktreeCards: false })
    vi.stubGlobal('window', {
      api: { ui: { set: setUI }, settings: { set: setSettings } }
    })
    const store = createUIStore()
    store.setState({
      settings: { compactWorktreeCards: true } as AppState['settings'],
      worktreeCardProperties: ['status', 'branch']
    })

    store.getState().setWorktreeCardMode('Default')

    const expected = getWorktreeCardModeProperties('Default')
    expect(store.getState().settings?.compactWorktreeCards).toBe(false)
    expect(store.getState().worktreeCardProperties).toEqual(expected)
    expect(setSettings).toHaveBeenCalledWith({ compactWorktreeCards: false })
    expect(setUI).toHaveBeenCalledWith({
      worktreeCardProperties: expected,
      _worktreeCardModeDefaulted: true
    })
  })

  it('sets Compact worktree card mode and removes migrated branch', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    const setSettings = vi.fn().mockResolvedValue({ compactWorktreeCards: true })
    vi.stubGlobal('window', {
      api: { ui: { set: setUI }, settings: { set: setSettings } }
    })
    const store = createUIStore()
    store.setState({
      settings: { compactWorktreeCards: false } as AppState['settings'],
      worktreeCardProperties: ['status', 'branch', 'inline-agents']
    })

    store.getState().setWorktreeCardMode('Compact')

    const expected = getWorktreeCardModeProperties('Compact')
    expect(store.getState().settings?.compactWorktreeCards).toBe(true)
    expect(store.getState().worktreeCardProperties).toEqual(expected)
    expect(store.getState().worktreeCardProperties).not.toContain('branch')
    expect(store.getState().worktreeCardProperties).not.toContain('inline-agents')
    expect(setSettings).toHaveBeenCalledWith({ compactWorktreeCards: true })
    expect(setUI).toHaveBeenCalledWith({
      worktreeCardProperties: expected,
      _worktreeCardModeDefaulted: true
    })
  })

  it('sets custom worktree card properties', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setWorktreeCardProperties(['inline-agents', 'inline-agents'])

    expect(store.getState().worktreeCardProperties).toEqual(['status', 'unread', 'inline-agents'])
    expect(store.getState()._worktreeCardModeDefaulted).toBe(false)
    expect(setUI).toHaveBeenCalledWith({
      worktreeCardProperties: ['status', 'unread', 'inline-agents'],
      _worktreeCardModeDefaulted: false
    })
  })

  it('persists the agent activity display mode', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setAgentActivityDisplayMode('full')

    expect(store.getState().agentActivityDisplayMode).toBe('full')
    expect(setUI).toHaveBeenCalledWith({ agentActivityDisplayMode: 'full' })
  })

  it('normalizes invalid persisted agent activity display modes', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        agentActivityDisplayMode: 'bogus' as PersistedUIState['agentActivityDisplayMode']
      })
    )

    expect(store.getState().agentActivityDisplayMode).toBe('compact')
  })
})
