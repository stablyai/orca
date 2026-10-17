// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { installCommandInferredPaneAgent } from './command-inferred-pane-agent'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

const initialAppState = useAppStore.getInitialState()

function codexStatus(state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: 'codex',
    stateHistory: []
  }
}

function codexTab(): TerminalTab {
  return {
    id: TAB_ID,
    worktreeId: WORKTREE_ID,
    ptyId: 'pty-1',
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    launchAgent: 'codex'
  }
}

function buildSession(): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bag supplies every field rememberCommandInferredPaneAgent reads; the rest of the session shape is never reached.
  const session = {
    cacheKey: PANE_KEY,
    deps: { worktreeId: WORKTREE_ID, tabId: TAB_ID },
    pane: { id: 1 }
  } as unknown as ConnectPanePtySession
  installCommandInferredPaneAgent(session)
  session.getLivePaneAgentTitle = () => 'zsh'
  return session
}

describe('rememberCommandInferredPaneAgent', () => {
  beforeEach(() => {
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE_ID]: [codexTab()] },
      terminalLayoutsByTabId: {
        [TAB_ID]: { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: LEAF_ID }
      },
      agentStatusByPaneKey: { [PANE_KEY]: codexStatus('done') },
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: null, shellForeground: true }
      },
      replaceTabLaunchAgent: vi.fn()
    })
  })

  it('accepts a typed different-family agent at the shell and replaces the launch latch', () => {
    const session = buildSession()
    session.appendPendingShellCommandInput('omp')
    session.rememberCommandInferredPaneAgent()

    expect(session.commandInferredPaneAgent).toBe('omp')
    expect(useAppStore.getState().replaceTabLaunchAgent).toHaveBeenCalledWith(TAB_ID, 'omp')
    // The stale done Codex row is dropped so a refresh cannot resurrect it (#24854).
    expect(useAppStore.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('retires a stale active hook at a single-leaf shell retarget and keeps shell evidence', () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: codexStatus('working') },
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: null, shellForeground: true }
      }
    })
    const session = buildSession()
    session.appendPendingShellCommandInput('omp')
    session.rememberCommandInferredPaneAgent()

    const state = useAppStore.getState()
    expect(session.commandInferredPaneAgent).toBe('omp')
    expect(state.agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
    expect(state.recentlyRetiredAgentStatusPaneKeys[PANE_KEY]).toEqual(expect.any(String))
    expect(state.paneForegroundAgentByPaneKey[PANE_KEY]).toEqual({
      agent: null,
      shellForeground: true
    })
  })

  it('preserves a fresh active hook at the same shell retarget boundary', () => {
    const fresh = {
      ...codexStatus('working'),
      updatedAt: Date.now(),
      stateStartedAt: Date.now()
    }
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: fresh },
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: null, shellForeground: true }
      }
    })
    const session = buildSession()
    session.appendPendingShellCommandInput('omp')
    session.rememberCommandInferredPaneAgent()

    expect(useAppStore.getState().agentStatusByPaneKey[PANE_KEY]).toBe(fresh)
    expect(useAppStore.getState().recentlyRetiredAgentStatusPaneKeys[PANE_KEY]).toBeUndefined()
  })

  it('keeps same-family typed inference off the launch latch (pi under omp)', () => {
    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [{ ...codexTab(), launchAgent: 'omp' }]
      }
    })
    const session = buildSession()
    session.appendPendingShellCommandInput('pi')
    session.rememberCommandInferredPaneAgent()

    expect(session.commandInferredPaneAgent).toBe('pi')
    expect(useAppStore.getState().replaceTabLaunchAgent).not.toHaveBeenCalled()
  })

  it('does not retarget a live TUI pane from keystrokes', () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: codexStatus('working') },
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: 'codex', agentEvidence: 'process-read', shellForeground: false }
      }
    })
    const session = buildSession()
    session.appendPendingShellCommandInput('omp')
    session.rememberCommandInferredPaneAgent()

    expect(session.commandInferredPaneAgent).toBeNull()
    expect(useAppStore.getState().replaceTabLaunchAgent).not.toHaveBeenCalled()
  })
})
