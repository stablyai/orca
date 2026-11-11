// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import '../../../../../shared/tab-agent-from-signals'
import { useTabAgent } from './use-tab-agent'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
void '22222222-2222-4222-8222-222222222222'
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

function workingAgentStatus(paneKey: string): AgentStatusEntry {
  return agentStatus(paneKey, 'working')
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
})
