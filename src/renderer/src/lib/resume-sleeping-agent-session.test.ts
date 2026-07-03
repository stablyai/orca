import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(leafId: string, ptyId = 'pty-1'): Record<string, unknown> {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function makeSplitLayout(
  leafId: string,
  otherLeafId: string,
  ptyIdsByLeafId: Record<string, string>
): Record<string, unknown> {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId },
      second: { type: 'leaf', leafId: otherLeafId },
      ratio: 0.5
    },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function makeActiveTerminalState(tabId: string, worktreeId = 'wt-1'): Record<string, unknown> {
  return {
    activeWorktreeId: worktreeId,
    activeTabType: 'terminal',
    activeTabId: tabId,
    activeTabIdByWorktree: { [worktreeId]: tabId }
  }
}

describe('resumeSleepingAgentSessionsForWorktree', () => {
  it('resumes quit-captured records when no preserved pane can own recovery', () => {
    const record = makeRecord({ origin: 'quit' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('resumes live-checkpoint records when no preserved pane can own recovery', () => {
    const record = makeRecord({ origin: 'live' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('resumes legacy sleep records without an origin when no preserved pane can own recovery', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = (state.tabsByWorktree['wt-1'] ?? []).find((tab) => tab.id !== 'tab-1')
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('skips worktree-sleep records owned by a preserved stable UUID pane', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('skips active stable-pane records owned by a single-leaf tab-level wake hint', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: {
        'wt-1': [{ ...makeTerminalTab('tab-1', 'wt-1'), ptyId: 'tab-level-wake-hint' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('skips active stable-pane records owned by a folder workspace active terminal', () => {
    const worktreeId = 'folder:folder-1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, worktreeId, origin: 'worktree-sleep' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1', worktreeId),
      tabsByWorktree: { [worktreeId]: [makeTerminalTab('tab-1', worktreeId)] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(worktreeId)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('resumes active worktree-sleep stable-pane records when the preserved tab is hidden during activation', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-2'),
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('tab-1', 'wt-1'), makeTerminalTab('tab-2', 'wt-1')]
      },
      terminalLayoutsByTabId: {
        'tab-1': makeLayout(LEAF_ID),
        'tab-2': makeLayout(OTHER_LEAF_ID, 'pty-2')
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find(
      (tab) => tab.id !== 'tab-1' && tab.id !== 'tab-2'
    )
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('rechecks pane ownership after an earlier fresh resume activates a new terminal', () => {
    const initiallyUnownedPaneKey = makePaneKey('missing-tab', OTHER_LEAF_ID)
    const initiallyOwnedPaneKey = makePaneKey('tab-active', LEAF_ID)
    const initiallyUnowned = makeRecord({
      paneKey: initiallyUnownedPaneKey,
      tabId: 'missing-tab',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'sess-first' },
      capturedAt: 1,
      updatedAt: 1
    })
    const initiallyOwned = makeRecord({
      paneKey: initiallyOwnedPaneKey,
      tabId: 'tab-active',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'sess-second' },
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-active'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-active', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-active': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: {
        [initiallyUnowned.paneKey]: initiallyUnowned,
        [initiallyOwned.paneKey]: initiallyOwned
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTabs = (state.tabsByWorktree['wt-1'] ?? []).filter(
      (tab) => tab.id !== 'tab-active'
    )
    expect(launched).toBe(2)
    expect(resumedTabs).toHaveLength(2)
    expect(Object.keys(state.pendingStartupByTabId)).toHaveLength(2)
    expect(state.sleepingAgentSessionsByPaneKey[initiallyUnowned.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[initiallyOwned.paneKey]).toBeUndefined()
  })

  it('skips active stable-pane records in an inactive split leaf of the active terminal tab', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep' })
    const layout = {
      ...makeSplitLayout(LEAF_ID, OTHER_LEAF_ID, {
        [LEAF_ID]: 'pty-1',
        [OTHER_LEAF_ID]: 'pty-2'
      }),
      activeLeafId: OTHER_LEAF_ID
    }
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': layout },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('skips active stable-pane records owned by a visible non-focused split-group terminal', () => {
    const paneKey = makePaneKey('tab-right', LEAF_ID)
    const record = makeRecord({ paneKey, tabId: 'tab-right', origin: 'worktree-sleep' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-left'),
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          { id: 'group-left', worktreeId: 'wt-1', activeTabId: 'unified-left', tabOrder: [] },
          { id: 'group-right', worktreeId: 'wt-1', activeTabId: 'unified-right', tabOrder: [] }
        ]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-left',
            entityId: 'tab-left',
            worktreeId: 'wt-1',
            groupId: 'group-left',
            contentType: 'terminal'
          },
          {
            id: 'unified-right',
            entityId: 'tab-right',
            worktreeId: 'wt-1',
            groupId: 'group-right',
            contentType: 'terminal'
          }
        ]
      },
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' },
          ratio: 0.5
        }
      },
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('tab-left', 'wt-1'), makeTerminalTab('tab-right', 'wt-1')]
      },
      terminalLayoutsByTabId: { 'tab-right': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(2)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('resumes active worktree-sleep stable-pane records when the preserved leaf has no PTY to cold-restore', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('resumes live stable-pane records when the preserved leaf has no PTY to cold-restore', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'live' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not let a sibling split-pane PTY claim a live stable-pane record', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'live' })
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [{ ...makeTerminalTab('tab-1', 'wt-1'), ptyId: 'tab-level-wake-hint' }]
      },
      ptyIdsByTabId: { 'tab-1': ['sibling-pty'] },
      terminalLayoutsByTabId: {
        'tab-1': makeSplitLayout(LEAF_ID, OTHER_LEAF_ID, { [OTHER_LEAF_ID]: 'sibling-pty' })
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('skips hibernated stable panes after their live PTY binding is cleared', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep', state: 'done' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('skips legacy numeric pane-key records owned by a preserved tab wake hint', () => {
    const record = makeRecord({ paneKey: 'tab-1:0', origin: 'worktree-sleep' })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: {
        'wt-1': [{ ...makeTerminalTab('tab-1', 'wt-1'), ptyId: 'wake-hint' }]
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('does not let mixed legacy provider sessions claim the whole preserved tab', () => {
    const first = makeRecord({
      paneKey: 'tab-1:0',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'sess-1' }
    })
    const second = makeRecord({
      paneKey: 'tab-1:1',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'sess-2' },
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [{ ...makeTerminalTab('tab-1', 'wt-1'), ptyId: 'wake-hint' }]
      },
      sleepingAgentSessionsByPaneKey: {
        [first.paneKey]: first,
        [second.paneKey]: second
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(2)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(3)
    expect(state.sleepingAgentSessionsByPaneKey[first.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[second.paneKey]).toBeUndefined()
  })

  it('resumes worktree-sleep records into a fresh tab', () => {
    const record = makeRecord({ origin: 'worktree-sleep' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const tabs = state.tabsByWorktree['wt-1'] ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[tabs[0]!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('uses captured launch config instead of changed settings when resuming worktree sleep', () => {
    const record = makeRecord({
      agent: 'codex',
      origin: 'worktree-sleep',
      launchConfig: {
        agentCommand: "codex --profile captured '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: { CODEX_PROFILE: 'captured' }
      }
    })
    useAppStore.setState({
      settings: {
        agentCmdOverrides: { codex: 'codex --profile changed' },
        agentDefaultArgs: { codex: '--model changed' },
        agentDefaultEnv: { codex: { CODEX_PROFILE: 'changed' } }
      },
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    const startup = state.pendingStartupByTabId[resumedTab!.id]
    expect(startup?.command).toBe(
      "codex --profile captured '--model' 'gpt-5' '--reasoning-effort' 'high' 'resume' 'sess-1'"
    )
    expect(startup?.env).toEqual({ CODEX_PROFILE: 'captured' })
    expect(startup?.command).not.toContain('changed')
    expect(startup?.launchConfig).toEqual(record.launchConfig)
    expect(startup?.resumeProviderSession).toEqual(record.providerSession)
  })

  it('launches once and clears skipped duplicates for the same provider session', () => {
    const first = makeRecord({
      paneKey: 'tab-1:leaf-1',
      capturedAt: 1,
      updatedAt: 1,
      launchConfig: { agentArgs: '--older', agentEnv: {} }
    })
    const duplicate = makeRecord({
      paneKey: 'tab-2:leaf-1',
      capturedAt: 2,
      updatedAt: 2,
      launchConfig: { agentArgs: '--newer', agentEnv: {} }
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: {
        [first.paneKey]: first,
        [duplicate.paneKey]: duplicate
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(1)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    expect(state.pendingStartupByTabId[resumedTab!.id]?.launchConfig).toMatchObject({
      agentArgs: '--newer'
    })
    expect(state.sleepingAgentSessionsByPaneKey[first.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[duplicate.paneKey]).toBeUndefined()
  })

  it('lets a preserved pane claim its provider session and clears only stale duplicates', () => {
    const ownedPaneKey = makePaneKey('tab-1', LEAF_ID)
    const stalePaneKey = makePaneKey('missing-tab', OTHER_LEAF_ID)
    const owned = makeRecord({ paneKey: ownedPaneKey, origin: 'worktree-sleep' })
    const stale = makeRecord({
      paneKey: stalePaneKey,
      tabId: 'missing-tab',
      origin: 'worktree-sleep',
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: {
        [owned.paneKey]: owned,
        [stale.paneKey]: stale
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[owned.paneKey]).toBe(owned)
    expect(state.sleepingAgentSessionsByPaneKey[stale.paneKey]).toBeUndefined()
  })

  it('lets quit/live pane-owned records claim provider sessions before stale duplicates launch', () => {
    const ownedPaneKey = makePaneKey('tab-1', LEAF_ID)
    const stalePaneKey = makePaneKey('missing-tab', OTHER_LEAF_ID)
    const owned = makeRecord({ paneKey: ownedPaneKey, origin: 'quit' })
    const stale = makeRecord({
      paneKey: stalePaneKey,
      tabId: 'missing-tab',
      origin: 'worktree-sleep',
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: {
        [owned.paneKey]: owned,
        [stale.paneKey]: stale
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[owned.paneKey]).toBe(owned)
    expect(state.sleepingAgentSessionsByPaneKey[stale.paneKey]).toBeUndefined()
  })

  it('does not let completed same-provider hibernation evidence launch before an active fresh resume', () => {
    const completedPaneKey = makePaneKey('tab-completed', OTHER_LEAF_ID)
    const activePaneKey = makePaneKey('tab-active', LEAF_ID)
    const completed = makeRecord({
      paneKey: completedPaneKey,
      tabId: 'tab-completed',
      origin: 'worktree-sleep',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      launchConfig: { agentArgs: '--completed', agentEnv: {} }
    })
    const active = makeRecord({
      paneKey: activePaneKey,
      tabId: 'tab-active',
      origin: 'worktree-sleep',
      capturedAt: 2,
      updatedAt: 2,
      launchConfig: { agentArgs: '--active', agentEnv: {} }
    })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-active'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-active', 'wt-1')] },
      terminalLayoutsByTabId: {
        'tab-active': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      },
      sleepingAgentSessionsByPaneKey: {
        [completed.paneKey]: completed,
        [active.paneKey]: active
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-active')
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
    expect(state.pendingStartupByTabId[resumedTab!.id]?.launchConfig).toMatchObject({
      agentArgs: '--active'
    })
    expect(state.sleepingAgentSessionsByPaneKey[completed.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[active.paneKey]).toBeUndefined()
  })

  it('does not let invalid pane-owned records block a valid duplicate resume', () => {
    const invalidPaneKey = makePaneKey('tab-1', LEAF_ID)
    const validPaneKey = makePaneKey('missing-tab', OTHER_LEAF_ID)
    const invalid = makeRecord({
      paneKey: invalidPaneKey,
      origin: 'live',
      capturedAt: 3_000_000,
      updatedAt: 1
    })
    const valid = makeRecord({
      paneKey: validPaneKey,
      tabId: 'missing-tab',
      origin: 'worktree-sleep',
      capturedAt: 3_000_001,
      updatedAt: 3_000_001
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: {
        [invalid.paneKey]: invalid,
        [valid.paneKey]: valid
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[invalid.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[valid.paneKey]).toBeUndefined()
  })

  it('fresh-resumes when explicit tabId disagrees with the stable pane-key tab id', () => {
    const paneKey = makePaneKey('parsed-tab', LEAF_ID)
    const record = makeRecord({ paneKey, tabId: 'explicit-tab', origin: 'worktree-sleep' })
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('explicit-tab', 'wt-1'), makeTerminalTab('parsed-tab', 'wt-1')]
      },
      terminalLayoutsByTabId: {
        'explicit-tab': makeLayout(LEAF_ID),
        'parsed-tab': makeLayout(LEAF_ID)
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find(
      (tab) => tab.id !== 'explicit-tab' && tab.id !== 'parsed-tab'
    )
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('clears completed worktree-sleep records without preserved panes instead of resuming', () => {
    const record = makeRecord({ origin: 'worktree-sleep', state: 'done' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toEqual([])
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('clears stale manual records without launching a tab', () => {
    const record = makeRecord({ capturedAt: 3_000_000, updatedAt: 1 })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('clears interrupted manual records without launching a tab', () => {
    const record = makeRecord({ origin: 'worktree-sleep', interrupted: true })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('clears hydrated interrupted worktree-sleep records without launching a tab', () => {
    const parsed = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': makeRecord({
          state: 'done',
          origin: 'worktree-sleep',
          interrupted: true
        })
      }
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    const record = parsed.value.sleepingAgentSessionsByPaneKey!['tab-1:leaf-1']!
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('clears legacy completed live records without launching a tab', () => {
    const record = makeRecord({ state: 'done' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('uses WSL resume quoting for Windows-path projects forced to WSL', () => {
    const record = makeRecord({
      providerSession: { key: 'session_id', id: "sess-1's" },
      origin: 'worktree-sleep'
    })
    useAppStore.setState({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: 'C:\\repo', displayName: 'repo', addedAt: 1 }],
      projects: [
        {
          id: 'repo-1',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ],
      settings: {
        localWindowsRuntimeDefault: { kind: 'windows-host' },
        agentCmdOverrides: {}
      },
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: 'C:\\repo',
            displayName: 'repo',
            branch: 'main'
          }
        ]
      },
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.command).toContain(
      "'--resume' 'sess-1'\\''s'"
    )
  })
})
