// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  ResumableTuiAgent,
  SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab, TuiAgent } from '../../../shared/types'
import { resolveTabAgentFromSignals, useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
let latestHookAgent: TuiAgent | null | undefined
const hookRoots: Root[] = []

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestHookAgent = useTabAgent(tab)
  return null
}

async function flushHookEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
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

function sleepingRecord(paneKey: string, agent: ResumableTuiAgent): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: 'wt-1',
    agent,
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe('resolveTabAgentFromSignals sleeping-session precedence', () => {
  it("prefers a hibernated pane's session identity over a stale reused launchAgent", () => {
    // Why: a codex launch later reused for claude leaves a claude sleeping record
    // for the pane. Its generic spinner title names no agent, so only the session
    // record proves the launch identity went stale.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠐ Explain GitHub issue simply',
        hookAgent: null,
        sleepingSessionAgent: 'claude',
        launchAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('keeps live hook identity ahead of a sleeping-session record', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: 'codex',
        sleepingSessionAgent: 'claude',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('keeps an explicit title ahead of a conflicting sleeping-session record', () => {
    // Why: sleeping identity ranks below title — a live/last-known explicit title
    // is at least as fresh as the hibernation snapshot.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        sleepingSessionAgent: 'gemini',
        launchAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('keeps a genuine tab icon when its sleeping record matches the launchAgent', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠐ working',
        hookAgent: null,
        sleepingSessionAgent: 'codex',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })
})

describe('useTabAgent sleeping-session', () => {
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

  it('paints a hibernated pane with its sleeping-session agent over a stale launchAgent', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    // Why: the pane was launched as codex, then reused for claude and hibernated.
    // No live hook/process remains and the frozen title names no agent, so the
    // persisted session record is the only proof the launch identity went stale.
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: { [paneKey]: sleepingRecord(paneKey, 'claude') }
    })

    await renderHookProbe({ ...baseTab, title: '⠐ Explain GitHub issue simply' })

    expect(latestHookAgent).toBe('claude')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })
})
