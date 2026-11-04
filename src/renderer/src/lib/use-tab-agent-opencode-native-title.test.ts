// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import '../../../shared/workspace-session-schema'
import '../../../shared/tab-agent-from-signals'
import { useTabAgent } from './use-tab-agent'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const initialAppState = useAppStore.getInitialState()
const FOCUSED_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
let latestAgent: TerminalAgent | null | undefined
let root: Root | null = null

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
