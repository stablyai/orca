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
  it('keeps launch intent during the pre-start shell window', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('trusts live hook identity at a shell title until the hook row is dropped', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('maps OpenClaude titles to the distinct OpenClaude tab icon', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '⠋ OpenClaude',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('openclaude')
  })

  it('keeps title fallback for real Gemini, MiMo, and Pi titles', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '✦ Gemini CLI',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('gemini')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'MiMo Code',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('mimo-code')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'π - my-project',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('pi')
  })

  it("uses completed OpenClaude hook identity over Claude's generic task-title heuristic", () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Say hi',
        hookAgent: null,
        focusedCompletedHookAgent: 'openclaude',
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it('keeps launch identity over title identity while hooks have not arrived', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '✳ Say hi',
        hookAgent: null,
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it("keeps Codex launch intent over Claude's generic spinner title fallback", () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '⠸ codex-quarter-flash-202606191419',
        hookAgent: null,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('does not infer Claude identity from a generic spinner title without context', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '⠸ investigating startup',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBeNull()
  })

  it('does not infer Claude identity from generic dot or star status titles', () => {
    for (const title of ['. investigating startup', '* investigating startup', '✳ investigating']) {
      expect(
        resolveTabAgentFromSignals({
          hasObservedAgentSignal: false,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: undefined
        })
      ).toBeNull()
    }
  })

  it('keeps launch identity over explicit title identity until stronger signals arrive', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '⠸ Claude Code',
        hookAgent: null,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it("uses Codex hook identity over Claude's generic task-title heuristic", () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ improve-pr-actions-customization',
        hookAgent: 'codex',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('keeps launch identity over explicit Claude Code titles without hook evidence', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it('lets an explicit title override stale launch identity after the pane shows newer activity', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('does not let an explicit title override launch identity before any activity is observed', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,

        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  // Pi/OMP identity (shared title-identity group, launchAgent-loss flicker)
  // lives in use-tab-agent-pi-identity.test.ts.

  it('prefers explicit hook identity over a conflicting title mention', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Gemini CLI',
        hookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('prefers explicit hook identity over ordinary non-Claude title identity', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✦ Gemini CLI',
        hookAgent: 'claude',
        launchAgent: 'gemini'
      })
    ).toBe('claude')
  })

  it('lets focused-pane hook identity override launch metadata in split tabs', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'claude',
        siblingHookAgent: 'gemini',
        launchAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('keeps unresolved launch metadata ahead of sibling-pane hook fallback', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        siblingHookAgent: 'claude',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('uses sibling-pane hook fallback when no launch metadata exists', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        siblingHookAgent: 'claude',
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('keeps launch identity over Claude-owned task text without hook evidence', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '✳ Gemini CLI',
        hookAgent: null,
        launchAgent: 'gemini'
      })
    ).toBe('gemini')
  })

  it('keeps launch identity over Claude-owned punctuation-prefixed task text', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '. Compare Opencode Vs Orca',
        hookAgent: null,
        launchAgent: 'opencode'
      })
    ).toBe('opencode')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '* Review Codex behavior',
        hookAgent: null,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('treats Claude-prefixed title text as Claude only when it names Claude', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('claude')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '. Claude Code compare Opencode',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('clears local launch identity once observed activity vanishes at a shell title', () => {
    // Why: matches the clear effect — the dropped hook row plus a shell title
    // is the crash/kill exit evidence, so the resolver must not lag it.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        launchAgent: 'codex'
      })
    ).toBeNull()
  })

  it('keeps launch identity at a shell title while a sibling hook row is live', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        siblingHookAgent: 'gemini',
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('keeps remote launch identity at a shell title without completed-hook evidence', () => {
    // Why: remote hook rows also drop on transport blips, so vanished activity
    // alone must not count as exit evidence for remote panes.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: 'zsh',
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('treats the neutral default title as exit evidence alongside shell titles', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'Terminal 2',
        defaultTitle: 'Terminal 2',
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBeNull()
  })

  it('keeps hook identity for remote panes', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: 'Terminal 1',
        hookAgent: 'codex',
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('keeps completed remote hook identity after the terminal title returns to a shell', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: 'zsh',
        hookAgent: null,
        focusedCompletedHookAgent: 'codex',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('clears local launch identity once a completed hook and shell title prove exit', () => {
    // Why: without foreground probing, a completed hook plus the title back at
    // a shell is the process-gone evidence — the same signals that clear the
    // sidebar row — so stale launch identity must not keep painting the tab.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBeNull()
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

  it('never probes the foreground process', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      agentStatusByPaneKey: {
        [paneKey]: workingAgentStatus(paneKey)
      }
    })

    const root = await renderHookProbe(baseTab)
    await rerenderHookProbe(root, { ...baseTab, title: '✳ Codex' })
    await rerenderHookProbe(root, { ...baseTab, title: 'zsh' })

    expect(latestHookAgent).toBe('codex')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('does not clear launch identity while the live hook row persists at a shell title', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      agentStatusByPaneKey: {
        [paneKey]: workingAgentStatus(paneKey)
      }
    })

    await renderHookProbe({ ...baseTab, title: 'zsh' })

    expect(latestHookAgent).toBe('codex')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })

  it('clears launch identity when a previously observed hook row drops at a shell title', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      agentStatusByPaneKey: {
        [paneKey]: workingAgentStatus(paneKey)
      }
    })

    const root = await renderHookProbe(baseTab)

    expect(latestHookAgent).toBe('codex')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()

    // Why: crash/kill exits drop the live row without a completed hook.
    await act(async () => {
      useAppStore.setState({ agentStatusByPaneKey: {} })
    })
    await rerenderHookProbe(root, { ...baseTab, title: 'zsh' })

    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it('uses completed local hook status as launch lifecycle evidence after remount', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [paneKey]: completedAgentStatus(paneKey)
      }
    })

    await renderHookProbe({ ...baseTab, title: 'zsh' })

    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
    expect(latestHookAgent).toBeNull()
    expect(getForegroundProcess).not.toHaveBeenCalled()
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
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('does not clear remote launch identity when the hook row drops at a shell title', async () => {
    const remotePtyId = 'remote:web-env-1@@terminal-1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': [remotePtyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: remotePtyId }
        }
      },
      agentStatusByPaneKey: {
        [paneKey]: workingAgentStatus(paneKey)
      }
    })
    const remoteTab = { ...baseTab, ptyId: remotePtyId, launchAgent: 'claude' as const }

    const root = await renderHookProbe(remoteTab)

    // Why: remote rows also drop on transport blips (reconnect, snapshot gaps)
    // that say nothing about the process — only a completed hook may clear.
    await act(async () => {
      useAppStore.setState({ agentStatusByPaneKey: {} })
    })
    await rerenderHookProbe(root, { ...remoteTab, title: 'zsh' })

    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
    expect(latestHookAgent).toBe('claude')
  })

  it('does not clear launch identity while a sibling hook row is still live', async () => {
    const focusedPaneKey = makePaneKey('tab-1', LEAF_ID)
    const siblingPaneKey = makePaneKey('tab-1', SECOND_LEAF_ID)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-focus', 'pty-sibling'] },
      terminalLayoutsByTabId: { 'tab-1': twoPaneLayout() },
      agentStatusByPaneKey: {
        [focusedPaneKey]: workingAgentStatus(focusedPaneKey),
        [siblingPaneKey]: workingAgentStatus(siblingPaneKey)
      }
    })
    const splitTab = { ...baseTab, ptyId: 'pty-focus', launchAgent: 'claude' as const }

    const root = await renderHookProbe(splitTab)

    // Focused row drops but the sibling agent still runs: no exit evidence yet.
    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: { [siblingPaneKey]: workingAgentStatus(siblingPaneKey) }
      })
    })
    await rerenderHookProbe(root, { ...splitTab, title: 'zsh' })
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.setState({ agentStatusByPaneKey: {} })
    })
    await rerenderHookProbe(root, { ...splitTab, title: 'zsh' })
    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it('clears launch identity at the neutral default title after a completed hook', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [paneKey]: completedAgentStatus(paneKey)
      }
    })

    // Why: the inferred-interrupt flow resets titles to the tab's default
    // ("Terminal N"), not a shell name — that must still count as exit.
    await renderHookProbe({ ...baseTab, title: 'Terminal 3', defaultTitle: 'Terminal 3' })

    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it('clears hookless launch identity once its own title evidence ends at a shell', async () => {
    const geminiTab = { ...baseTab, launchAgent: 'gemini' as const, title: '✦ Gemini CLI' }

    // Why: agents without hook integration prove activity via a title naming
    // the launched agent; the later shell title is then exit evidence.
    const root = await renderHookProbe(geminiTab)
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()

    await rerenderHookProbe(root, { ...geminiTab, title: 'zsh' })

    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it('does not treat a layout-less multi-pane completed row as focused exit evidence', async () => {
    const siblingPaneKey = makePaneKey('tab-1', SECOND_LEAF_ID)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-focus', 'pty-sibling'] },
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {
        [siblingPaneKey]: completedAgentStatus(siblingPaneKey)
      }
    })

    await renderHookProbe({ ...baseTab, ptyId: 'pty-focus', title: 'zsh', launchAgent: 'claude' })

    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })

  it('does not clear launch identity on the commit that switches pane generations', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const boundLayout = {
      root: { type: 'leaf', leafId: LEAF_ID } as const,
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
    }
    useAppStore.setState({
      terminalLayoutsByTabId: { 'tab-1': boundLayout },
      agentStatusByPaneKey: { [paneKey]: workingAgentStatus(paneKey) }
    })

    const root = await renderHookProbe(baseTab)
    expect(latestHookAgent).toBe('codex')

    // Why: a respawn/focus switch can land the new ptyId, the dropped row, and
    // a shell title in one commit — the previous generation's observed signal
    // must not clear the new generation's launch identity.
    await act(async () => {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          'tab-1': { ...boundLayout, ptyIdsByLeafId: { [LEAF_ID]: 'pty-2' } }
        },
        agentStatusByPaneKey: {}
      })
    })
    await rerenderHookProbe(root, { ...baseTab, title: 'zsh' })

    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })
})
