import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
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

describe('resumeSleepingAgentSessionsForWorktree', () => {
  it('skips quit-captured records — their restored pane owns recovery', () => {
    const record = makeRecord({ origin: 'quit' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    // Why: the restored pane either warm-reattaches the still-running agent or
    // cold-restores with the resume command; a separate tab here would
    // duplicate the session.
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('skips live-checkpoint records — their restored pane owns recovery', () => {
    const record = makeRecord({ origin: 'live' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
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

  it('skips legacy numeric pane-key records owned by a preserved tab wake hint', () => {
    const record = makeRecord({ paneKey: 'tab-1:0', origin: 'worktree-sleep' })
    useAppStore.setState({
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
  })

  it('launches once and clears skipped duplicates for the same provider session', () => {
    const first = makeRecord({ paneKey: 'tab-1:leaf-1', capturedAt: 1, updatedAt: 1 })
    const duplicate = makeRecord({ paneKey: 'tab-2:leaf-1', capturedAt: 2, updatedAt: 2 })
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
