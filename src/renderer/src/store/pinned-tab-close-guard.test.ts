import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({
  getStateMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel
} from './pinned-tab-close-guard'
import type { Tab } from '../../../shared/tab-types'
import type { AppState } from './types'

function makeState(overrides: Partial<AppState>): AppState {
  return {
    settings: { confirmClosePinnedTab: true },
    unifiedTabsByWorktree: {},
    requestPinnedTabCloseConfirm: vi.fn(),
    cancelPinnedTabCloseRequest: vi.fn(),
    ...overrides
  } as unknown as AppState
}

describe('guardPinnedTabClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('closes immediately for a non-pinned tab without touching the store', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(makeState({ requestPinnedTabCloseConfirm }))

    guardPinnedTabClose({ isPinned: false, tabLabel: 'Docs', onClose })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
  })

  it('requests confirmation for a pinned tab when the setting is on', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: { confirmClosePinnedTab: true } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardPinnedTabClose({ isPinned: true, tabLabel: 'Docs', onClose })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith({
      tabLabel: 'Docs',
      onConfirm: onClose
    })
  })

  it('passes cancel callbacks to confirmation requests', () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: { confirmClosePinnedTab: true } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardPinnedTabClose({ isPinned: true, tabLabel: 'Docs', onClose, onCancel })

    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith({
      tabLabel: 'Docs',
      onConfirm: onClose,
      onCancel
    })
  })

  it('returns a cancellation for the exact queued confirmation', () => {
    const cancelPinnedTabCloseRequest = vi.fn()
    getStateMock.mockReturnValue(makeState({ cancelPinnedTabCloseRequest }))

    const cancel = guardPinnedTabClose({ isPinned: true, tabLabel: 'Docs', onClose: vi.fn() })
    const request = getStateMock().requestPinnedTabCloseConfirm.mock.calls[0][0]
    cancel?.()

    expect(cancelPinnedTabCloseRequest).toHaveBeenCalledWith(request)
  })

  it('closes a pinned tab immediately when the setting is off', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        settings: { confirmClosePinnedTab: false } as AppState['settings'],
        requestPinnedTabCloseConfirm
      })
    )

    guardPinnedTabClose({ isPinned: true, tabLabel: 'Docs', onClose })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
  })

  it('defaults to confirming when settings are not loaded yet', () => {
    const onClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(makeState({ settings: null, requestPinnedTabCloseConfirm }))

    guardPinnedTabClose({ isPinned: true, tabLabel: 'Docs', onClose })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('resolvePinnedTabLabel', () => {
  it('uses the same label priority as the tab strip', () => {
    const state = makeState({
      settings: {
        confirmClosePinnedTab: true,
        tabAutoGenerateTitle: true
      } as AppState['settings'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'a',
            entityId: 'ea',
            customLabel: ' Custom ',
            quickCommandLabel: 'Run tests',
            generatedLabel: 'Gen',
            label: 'Plain'
          },
          {
            id: 'b',
            entityId: 'eb',
            customLabel: '   ',
            quickCommandLabel: ' Run tests ',
            generatedLabel: 'Gen',
            label: 'Plain'
          },
          {
            id: 'c',
            entityId: 'ec',
            customLabel: null,
            quickCommandLabel: null,
            generatedLabel: ' Gen ',
            label: 'Plain'
          },
          {
            id: 'd',
            entityId: 'ed',
            customLabel: null,
            quickCommandLabel: null,
            generatedLabel: null,
            label: ' Plain '
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree']
    })

    expect(resolvePinnedTabLabel(state, 'wt-1', 'a')).toBe('Custom')
    expect(resolvePinnedTabLabel(state, 'wt-1', 'b')).toBe('Run tests')
    expect(resolvePinnedTabLabel(state, 'wt-1', 'ec')).toBe('Gen')
    expect(resolvePinnedTabLabel(state, 'wt-1', 'ed')).toBe('Plain')
  })

  it('falls back to the live label when generated tab titles are disabled', () => {
    const state = makeState({
      settings: {
        confirmClosePinnedTab: true,
        tabAutoGenerateTitle: false
      } as AppState['settings'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'a',
            entityId: 'ea',
            customLabel: null,
            quickCommandLabel: null,
            generatedLabel: 'Gen',
            label: 'Plain'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree']
    })

    expect(resolvePinnedTabLabel(state, 'wt-1', 'a')).toBe('Plain')
  })

  it('returns an empty string when the tab is not found', () => {
    expect(resolvePinnedTabLabel(makeState({}), 'wt-1', 'missing')).toBe('')
  })
})

describe('isUnifiedTabPinned', () => {
  const state = makeState({
    unifiedTabsByWorktree: {
      'wt-1': [
        { id: 'uni-1', entityId: 'ent-1', isPinned: true },
        { id: 'uni-2', entityId: 'ent-2', isPinned: false }
      ]
    } as unknown as AppState['unifiedTabsByWorktree']
  })

  it('matches a pinned tab by its unified id or entityId', () => {
    expect(isUnifiedTabPinned(state, 'wt-1', 'uni-1')).toBe(true)
    expect(isUnifiedTabPinned(state, 'wt-1', 'ent-1')).toBe(true)
  })

  it('returns false for unpinned or unknown tabs', () => {
    expect(isUnifiedTabPinned(state, 'wt-1', 'uni-2')).toBe(false)
    expect(isUnifiedTabPinned(state, 'wt-1', 'missing')).toBe(false)
    expect(isUnifiedTabPinned(state, 'wt-unknown', 'uni-1')).toBe(false)
  })
})

/** A complete Tab so the doubles below need no type assertion. */
function makeTabDouble(id: string, contentType: Tab['contentType'], extra: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: id,
    groupId: 'g-home',
    worktreeId: 'wt-1',
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

/** The only settings field this guard reads, as the surrounding doubles already shape it. */
function makeSettings(confirmClosePinnedTab: boolean): AppState['settings'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guardPinnedTabClose reads only `confirmClosePinnedTab` (via shouldConfirmPinnedTabClose); a real GlobalSettings would add hundreds of unrelated fields to this double.
  return { confirmClosePinnedTab } as AppState['settings']
}

describe('guardPinnedTabClose for the Agents tab', () => {
  const WT = 'wt-1'

  function makeAgentsState(
    overrides: Partial<AppState> = {},
    confirmClosePinnedTab = true
  ): AppState {
    return makeState({
      unifiedTabsByWorktree: {
        [WT]: [
          makeTabDouble('agents-tab', 'agents', { entityId: 'agents:wt-1', isPinned: true }),
          makeTabDouble('a0', 'agent-session', { groupId: 'g-card-0' }),
          makeTabDouble('a1', 'agent-session', { groupId: 'g-card-1' })
        ]
      },
      tabsByWorktree: { [WT]: [] },
      agentCardGroupIdsByWorktree: { [WT]: ['g-card-0', 'g-card-1'] },
      settings: makeSettings(confirmClosePinnedTab),
      ...overrides
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks about the agents it hosts rather than about the tab being pinned', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const onClose = vi.fn()
    getStateMock.mockReturnValue(makeAgentsState({ requestPinnedTabCloseConfirm }))

    guardPinnedTabClose({
      isPinned: true,
      tabLabel: 'Agents',
      onClose,
      worktreeId: WT,
      tabId: 'agents-tab'
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm.mock.calls[0][0].agentCount).toBe(2)
  })

  it('confirming closes the agents, not the host tab, so the reconciler cannot rebuild it', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeAllAgentCards = vi.fn()
    const onClose = vi.fn()
    getStateMock.mockReturnValue(
      makeAgentsState({ requestPinnedTabCloseConfirm, closeAllAgentCards })
    )

    guardPinnedTabClose({
      isPinned: true,
      tabLabel: 'Agents',
      onClose,
      worktreeId: WT,
      tabId: 'agents-tab'
    })
    requestPinnedTabCloseConfirm.mock.calls[0][0].onConfirm()

    expect(closeAllAgentCards).toHaveBeenCalledWith(WT)
    // Why: closing only the host tab is what made the action read as doing nothing at all.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still asks when the pinned-tab confirmation preference is off', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(makeAgentsState({ requestPinnedTabCloseConfirm }, false))

    guardPinnedTabClose({
      isPinned: true,
      tabLabel: 'Agents',
      onClose: vi.fn(),
      worktreeId: WT,
      tabId: 'agents-tab'
    })

    // That preference answers "this tab is pinned", never "end these agent sessions".
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
  })

  it('counts only the agents the Agents tab hosts, not overflow agents left as tabs', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        requestPinnedTabCloseConfirm,
        settings: makeSettings(true),
        unifiedTabsByWorktree: {
          [WT]: [
            makeTabDouble('agents-tab', 'agents', { entityId: 'agents:wt-1', isPinned: true }),
            makeTabDouble('a0', 'agent-session', { groupId: 'g-card-0' }),
            makeTabDouble('a1', 'agent-session', { groupId: 'g-card-1' }),
            // Past the card cap this agent stays an ordinary top-level tab.
            makeTabDouble('overflow', 'agent-session', { groupId: 'g-home' })
          ]
        },
        tabsByWorktree: { [WT]: [] },
        agentCardGroupIdsByWorktree: { [WT]: ['g-card-0', 'g-card-1'] }
      })
    )

    guardPinnedTabClose({
      isPinned: true,
      tabLabel: 'Agents',
      onClose: vi.fn(),
      worktreeId: WT,
      tabId: 'agents-tab'
    })

    // Why this matters: the overflow agent is not inside the tab being closed, so neither the
    // count nor the close may reach it.
    expect(requestPinnedTabCloseConfirm.mock.calls[0][0].agentCount).toBe(2)
  })

  it('falls back to the ordinary pinned prompt once no agents are left', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      makeState({
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          [WT]: [makeTabDouble('agents-tab', 'agents', { entityId: 'agents:wt-1', isPinned: true })]
        },
        tabsByWorktree: { [WT]: [] }
      })
    )

    guardPinnedTabClose({
      isPinned: true,
      tabLabel: 'Agents',
      onClose: vi.fn(),
      worktreeId: WT,
      tabId: 'agents-tab'
    })

    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm.mock.calls[0][0].agentCount).toBeUndefined()
  })
})
