// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'
import { useTabAgent } from './use-tab-agent'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const initialAppState = useAppStore.getInitialState()
const FOCUSED_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
let latestAgent: TuiAgent | null | undefined
let root: Root | null = null
const identityScenarios: [
  string,
  { isRemote: boolean; title?: string; siblingHookAgent?: TuiAgent }
][] = [
  ['live local', { isRemote: false }],
  ['inactive local split', { isRemote: false, siblingHookAgent: 'claude' }],
  ['inactive SSH/tmux', { isRemote: true, title: 'tmux | OC | Greeting' }],
  ['multi-token SSH wrapper', { isRemote: true, title: 'ssh build-host | OC | Greeting' }]
]

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestAgent = useTabAgent(tab)
  return null
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: FOCUSED_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [FOCUSED_LEAF_ID]: 'pty-opencode',
      [SIBLING_LEAF_ID]: 'pty-sibling'
    }
  }
}

function sleepingClaudeRecord(paneKey: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: 'opencode-tab',
    worktreeId: 'worktree-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'claude-session' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
}

describe('OpenCode native title tab identity', () => {
  const originalApi = window.api
  const getForegroundProcess = vi.fn()
  const clearTabLaunchAgent = vi.fn()
  const staleClaudeTab: TerminalTab = {
    id: 'opencode-tab',
    ptyId: 'pty-opencode',
    worktreeId: 'worktree-1',
    title: 'OC | Greeting',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: 'claude'
  }

  beforeEach(() => {
    latestAgent = undefined
    getForegroundProcess.mockReset()
    clearTabLaunchAgent.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      activeTabId: 'other-tab',
      ptyIdsByTabId: { 'opencode-tab': ['pty-opencode'] },
      agentStatusByPaneKey: {},
      terminalLayoutsByTabId: {},
      clearTabLaunchAgent
    })
    window.api = {
      ...originalApi,
      pty: {
        ...originalApi?.pty,
        getForegroundProcess
      }
    } as typeof window.api
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    window.api = originalApi
  })

  it.each(identityScenarios)(
    'uses native OpenCode identity for a %s tab with stale Claude metadata',
    (_name, extra) => {
      expect(
        resolveTabAgentFromSignals({
          hasObservedAgentSignal: false,
          isRemote: extra.isRemote,
          title: extra.title ?? 'OC | Greeting',
          hookAgent: null,
          launchAgent: 'claude',
          siblingHookAgent: extra.siblingHookAgent
        })
      ).toBe('opencode')
    }
  )

  it('reclaims stale Claude identity loaded from a persisted tab', () => {
    const parsed = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'worktree-1',
      activeTabId: 'opencode-tab',
      tabsByWorktree: { 'worktree-1': [staleClaudeTab] },
      terminalLayoutsByTabId: {}
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    const restoredTab = parsed.value.tabsByWorktree['worktree-1']![0]!

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: restoredTab.title,
        hookAgent: null,
        launchAgent: restoredTab.launchAgent
      })
    ).toBe('opencode')
  })

  it('keeps current sleeping Claude ownership over a replayed OpenCode title', () => {
    for (const hasObservedAgentSignal of [false, true]) {
      expect(
        resolveTabAgentFromSignals({
          hasObservedAgentSignal,
          isRemote: true,
          title: 'tmux | OC | Previous task',
          hookAgent: null,
          sleepingSessionAgent: 'claude',
          launchAgent: 'claude'
        })
      ).toBe('claude')
    }
  })

  it.each([false, true])(
    'keeps completed Claude ownership over an SSH/tmux restored title when observed=%s',
    (hasObservedAgentSignal) => {
      expect(
        resolveTabAgentFromSignals({
          hasObservedAgentSignal,
          isRemote: true,
          title: 'tmux | OC | Previous task',
          hookAgent: null,
          focusedCompletedHookAgent: 'claude',
          launchAgent: 'claude'
        })
      ).toBe('claude')
    }
  )

  it('keeps matching sleeping ownership and preserves the no-signal fallback', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: true,
        title: 'tmux | OC | Current task',
        hookAgent: null,
        sleepingSessionAgent: 'opencode',
        launchAgent: 'opencode'
      })
    ).toBe('opencode')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: true,
        title: 'Terminal 1',
        hookAgent: null
      })
    ).toBeNull()
  })

  it('keeps restored split-pane ownership over an SSH/tmux title replay', () => {
    const paneKey = makePaneKey('opencode-tab', FOCUSED_LEAF_ID)
    const parsed = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'worktree-1',
      activeTabId: 'opencode-tab',
      tabsByWorktree: {
        'worktree-1': [{ ...staleClaudeTab, title: 'tmux | OC | Previous task' }]
      },
      terminalLayoutsByTabId: { 'opencode-tab': splitLayout() },
      sleepingAgentSessionsByPaneKey: { [paneKey]: sleepingClaudeRecord(paneKey) }
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    const restoredTab = parsed.value.tabsByWorktree['worktree-1']![0]!
    const restoredSleeping = parsed.value.sleepingAgentSessionsByPaneKey?.[paneKey]

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: true,
        title: restoredTab.title,
        hookAgent: null,
        sleepingSessionAgent: restoredSleeping?.agent,
        launchAgent: restoredTab.launchAgent
      })
    ).toBe('claude')
  })

  it('keeps stronger live identity and rejects non-native OpenCode lookalikes', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'OC | Greeting',
        hookAgent: 'claude',
        sleepingSessionAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('claude')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'OC | Greeting',
        hookAgent: null,
        processAgent: 'codex',
        sleepingSessionAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('codex')

    for (const title of [
      'OpenCode ready',
      'oc | Greeting',
      '⠋ Fix foo | OC | Greeting',
      '✦ Gemini CLI',
      '⠋ Codex',
      'Cursor Agent',
      'Pi ready'
    ]) {
      expect(
        resolveTabAgentFromSignals({
          hasObservedAgentSignal: false,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: 'claude'
        })
      ).toBe('claude')
    }
  })

  it('updates a mounted inactive/restored split without provider probes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(HookProbe, { tab: staleClaudeTab }))
      await Promise.resolve()
    })

    expect(latestAgent).toBe('opencode')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
    expect(getForegroundProcess).not.toHaveBeenCalled()
    const paneKey = makePaneKey('opencode-tab', FOCUSED_LEAF_ID)

    await act(async () => {
      useAppStore.setState({
        ptyIdsByTabId: { 'opencode-tab': ['pty-opencode', 'pty-sibling'] },
        terminalLayoutsByTabId: { 'opencode-tab': splitLayout() },
        sleepingAgentSessionsByPaneKey: { [paneKey]: sleepingClaudeRecord(paneKey) }
      })
      root?.render(
        createElement(HookProbe, {
          tab: { ...staleClaudeTab, title: 'tmux | OC | Previous task' }
        })
      )
      await Promise.resolve()
    })

    expect(latestAgent).toBe('claude')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })
})
