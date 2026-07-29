// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalTab, TuiAgent } from '../../../shared/types'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { resolveTabAgentFromSignals, useTabAgent } from './use-tab-agent'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const initialAppState = useAppStore.getInitialState()
let latestAgent: TuiAgent | null | undefined
let root: Root | null = null
const identityScenarios: [
  string,
  { isRemote: boolean; title?: string; siblingHookAgent?: TuiAgent }
][] = [
  ['live local', { isRemote: false }],
  ['inactive local split', { isRemote: false, siblingHookAgent: 'claude' }],
  ['inactive SSH/tmux', { isRemote: true, title: 'tmux | OC | Greeting' }]
]

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestAgent = useTabAgent(tab)
  return null
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

  it('keeps stronger live identity and rejects non-native OpenCode lookalikes', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'OC | Greeting',
        hookAgent: 'claude',
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
        launchAgent: 'claude'
      })
    ).toBe('codex')

    for (const title of [
      'OpenCode ready',
      'oc | Greeting',
      'my session | OC | Greeting',
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

  it('updates a mounted inactive tab without clearing metadata or probing providers', async () => {
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
  })
})
