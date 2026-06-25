// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab, TuiAgent } from '../../../shared/types'
import { resolveTabAgentFromSignals, useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
let latestHookAgent: TuiAgent | null | undefined
const hookRoots: Root[] = []

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestHookAgent = useTabAgent(tab)
  return null
}

async function renderHookProbe(tab: TerminalTab): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  hookRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { tab }))
  })
  await flushHookEffects()
  return root
}

async function rerenderHookProbe(root: Root, tab: TerminalTab): Promise<void> {
  await act(async () => {
    root.render(createElement(HookProbe, { tab }))
  })
  await flushHookEffects()
}

async function flushHookEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function agentStatus(paneKey: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: 'codex',
    paneKey,
    stateHistory: []
  }
}

function completedAgentStatus(paneKey: string): AgentStatusEntry {
  return agentStatus(paneKey, 'done')
}

function workingAgentStatus(paneKey: string): AgentStatusEntry {
  return agentStatus(paneKey, 'working')
}

function twoPaneLayout(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [LEAF_ID]: 'pty-focus',
      [SECOND_LEAF_ID]: 'pty-sibling'
    }
  }
}

describe('resolveTabAgentFromSignals', () => {
  it('uses a recognized foreground agent as the live local source of truth', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: 'codex',
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('keeps launch intent during the pre-start shell window', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('lets shell foreground clear stale identity even when the title still names an agent', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })

  it('maps OpenClaude titles to the distinct OpenClaude tab icon', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '⠋ OpenClaude',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('openclaude')
  })

  it('keeps title fallback for real Gemini and Pi titles', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✦ Gemini CLI',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('gemini')

    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'π - my-project',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('pi')
  })

  it("uses completed OpenClaude hook identity over Claude's generic task-title heuristic", () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Say hi',
        hookAgent: null,
        hasCompletedHook: true,
        completedHookAgent: 'openclaude',
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it('keeps launch identity over title identity while hooks have not arrived', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Say hi',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it("keeps Codex launch intent over Claude's generic spinner title fallback", () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '⠸ codex-quarter-flash-202606191419',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('does not infer Claude identity from a generic spinner title without context', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '⠸ investigating startup',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBeNull()
  })

  it('does not infer Claude identity from generic dot or star status titles', () => {
    for (const title of ['. investigating startup', '* investigating startup', '✳ investigating']) {
      expect(
        resolveTabAgentFromSignals({
          foreground: undefined,
          hasObservedAgentSignal: false,
          shellForegroundAfterAgentSignal: false,
          isRemote: false,
          title,
          hookAgent: null,
          hasCompletedHook: false,
          launchAgent: undefined
        })
      ).toBeNull()
    }
  })

  it('keeps launch identity over explicit title identity until stronger signals arrive', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '⠸ Claude Code',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it("uses Codex hook identity over Claude's generic task-title heuristic", () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ improve-pr-actions-customization',
        hookAgent: 'codex',
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('keeps launch identity over explicit Claude Code titles without hook or foreground evidence', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it('lets shell foreground clear the icon after an agent was observed running', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })

  it('does not let a pre-start shell sample suppress a later hook signal', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'codex',
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('prefers explicit hook identity over a conflicting title mention', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Gemini CLI',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('prefers explicit hook identity over ordinary non-Claude title identity', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✦ Gemini CLI',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'gemini'
      })
    ).toBe('claude')
  })

  it('lets focused-pane hook identity override launch metadata in split tabs', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'claude',
        siblingHookAgent: 'gemini',
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('keeps unresolved launch metadata ahead of sibling-pane hook fallback', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        siblingHookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('uses sibling-pane hook fallback when no launch metadata exists', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        siblingHookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('keeps launch identity over Claude-owned task text without hook or foreground evidence', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Gemini CLI',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'gemini'
      })
    ).toBe('gemini')
  })

  it('keeps launch identity over Claude-owned punctuation-prefixed task text', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '. Compare Opencode Vs Orca',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'opencode'
      })
    ).toBe('opencode')

    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '* Review Codex behavior',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('treats Claude-prefixed title text as Claude only when it names Claude', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('claude')

    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '. Claude Code compare Opencode',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('keeps local launch identity when only a shell title suggests exit', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('skips local foreground authority for remote worktrees', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: true,
        isRemote: true,
        title: 'Terminal 1',
        hookAgent: 'codex',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('keeps completed remote hook identity after the terminal title returns to a shell', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: true,
        title: 'zsh',
        hookAgent: null,
        hasCompletedHook: true,
        completedHookAgent: 'codex',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('keeps local launch identity after a completed hook until foreground proves shell exit', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        hasCompletedHook: true,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })
})

describe('useTabAgent', () => {
  const originalApi = window.api
  const getForegroundProcess = vi.fn()
  const clearTabLaunchAgent = vi.fn()
  const baseTab: TerminalTab = {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: 'codex'
  }

  beforeEach(() => {
    latestHookAgent = undefined
    getForegroundProcess.mockReset()
    clearTabLaunchAgent.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
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
    hookRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    window.api = originalApi
  })

  it('uses unrecognized non-shell foreground as launch lifecycle evidence', async () => {
    getForegroundProcess.mockResolvedValueOnce('node').mockResolvedValueOnce('zsh')

    const root = await renderHookProbe(baseTab)

    expect(latestHookAgent).toBe('codex')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()

    await rerenderHookProbe(root, { ...baseTab, title: 'zsh' })

    expect(clearTabLaunchAgent).toHaveBeenCalledExactlyOnceWith('tab-1')
    expect(latestHookAgent).toBeNull()
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('uses completed local hook status as launch lifecycle evidence after remount', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('zsh')
    useAppStore.setState({
      agentStatusByPaneKey: {
        [paneKey]: completedAgentStatus(paneKey)
      }
    })

    await renderHookProbe({ ...baseTab, title: 'zsh' })

    expect(clearTabLaunchAgent).toHaveBeenCalledExactlyOnceWith('tab-1')
    expect(latestHookAgent).toBeNull()
    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
  })

  it('treats paired runtime PTYs as remote-like for completed hook fallback', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['remote:web-env-1@@terminal-1'] },
      agentStatusByPaneKey: {
        [paneKey]: completedAgentStatus(paneKey)
      }
    })

    await renderHookProbe({
      ...baseTab,
      ptyId: 'remote:web-env-1@@terminal-1',
      title: 'zsh',
      launchAgent: undefined
    })

    expect(latestHookAgent).toBe('codex')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('does not let a split-tab fallback PTY suppress missing-layout hook identity', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-shell', 'pty-agent'] },
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {
        [paneKey]: workingAgentStatus(paneKey)
      }
    })

    await renderHookProbe({
      ...baseTab,
      title: 'zsh',
      launchAgent: 'claude'
    })

    expect(latestHookAgent).toBe('codex')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('does not use completed sibling hook status as focused launch lifecycle evidence', async () => {
    const siblingPaneKey = makePaneKey('tab-1', SECOND_LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('zsh')
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-focus', 'pty-sibling'] },
      terminalLayoutsByTabId: { 'tab-1': twoPaneLayout() },
      agentStatusByPaneKey: {
        [siblingPaneKey]: completedAgentStatus(siblingPaneKey)
      }
    })

    await renderHookProbe({
      ...baseTab,
      ptyId: 'pty-focus',
      title: 'zsh',
      launchAgent: 'claude'
    })

    expect(latestHookAgent).toBe('claude')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-focus')
  })
})
