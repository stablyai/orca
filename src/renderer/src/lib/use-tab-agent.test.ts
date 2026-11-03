// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import '../../../shared/tab-agent-from-signals'
import { useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
let latestHookAgent: TerminalAgent | null | undefined
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

    // Remote transport gaps do not prove exit; require completion evidence to clear identity.
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

    // Inferred interrupts reset to neutral Terminal N, which must count like a shell title as exit evidence.
    await renderHookProbe({ ...baseTab, title: 'Terminal 3', defaultTitle: 'Terminal 3' })

    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it('clears hookless launch identity once its own title evidence ends at a shell', async () => {
    const geminiTab = { ...baseTab, launchAgent: 'gemini' as const, title: '✦ Gemini CLI' }

    // Hookless agents first prove activity through their own title; later shell title then proves exit.
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

    // Respawn can replace PTY, drop hook and show shell in one commit; old-generation observations must not clear new launch intent.
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
