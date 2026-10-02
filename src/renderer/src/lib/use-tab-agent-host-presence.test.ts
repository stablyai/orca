// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const FOCUSED_LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
const FOCUSED = makePaneKey('tab-1', FOCUSED_LEAF)
const SIBLING = makePaneKey('tab-1', SIBLING_LEAF)
const claude = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:1' }
} as const
const tab: TerminalTab = {
  id: 'tab-1',
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  title: 'codex',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

let latest: TuiAgent | null | undefined
const roots: Root[] = []
function Probe({ tab: probeTab }: { tab: TerminalTab }): null {
  latest = useTabAgent(probeTab)
  return null
}

async function render(probeTab: TerminalTab, reuse?: Root): Promise<Root> {
  const root = reuse ?? createRoot(document.body.appendChild(document.createElement('div')))
  if (!reuse) {
    roots.push(root)
  }
  await act(async () => {
    root.render(createElement(Probe, { tab: probeTab }))
  })
  await act(async () => {
    await Promise.resolve()
  })
  return root
}

function codexRow(paneKey: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    agentType: 'codex',
    paneKey,
    stateHistory: []
  }
}

function splitLayout(): void {
  useAppStore.setState({
    terminalLayoutsByTabId: {
      'tab-1': {
        root: null,
        activeLeafId: FOCUSED_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [FOCUSED_LEAF]: 'pty-1', [SIBLING_LEAF]: 'pty-2' }
      }
    }
  })
}

describe('useTabAgent with host presence', () => {
  const clearTabLaunchAgent = vi.fn()
  beforeEach(() => {
    latest = undefined
    clearTabLaunchAgent.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] }, clearTabLaunchAgent })
  })
  afterEach(() => {
    roots.splice(0).forEach((root) => act(() => root.unmount()))
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it.each([false, true])(
    'keeps the focused Codex pane over an identified Claude sibling, ended=%s',
    async (ended) => {
      splitLayout()
      useAppStore.setState({
        agentStatusByPaneKey: { [FOCUSED]: codexRow(FOCUSED) },
        agentPresenceByPaneKey: {
          [SIBLING]: { presence: ended ? { ...claude, ended: true } : claude, receivedAt: 1 }
        }
      })
      await render({ ...tab, launchAgent: 'codex' })
      expect(latest).toBe('codex')
      expect(clearTabLaunchAgent).not.toHaveBeenCalled()
    }
  )

  it('shows a later hookless agent in the pane its identified owner exited', async () => {
    splitLayout()
    useAppStore.setState({
      agentPresenceByPaneKey: {
        [FOCUSED]: { presence: { ...claude, ended: true }, receivedAt: 1 }
      },
      paneForegroundAgentByPaneKey: {
        [FOCUSED]: { agent: 'codex', agentEvidence: 'process-read', shellForeground: false }
      }
    })
    await render({ ...tab, title: 'orca' })
    expect(latest).toBe('codex')
  })

  it('keeps the launched agent at a Git Bash prompt title when no owner is identified', async () => {
    splitLayout()
    useAppStore.setState({ agentStatusByPaneKey: { [FOCUSED]: codexRow(FOCUSED) } })
    const root = await render({ ...tab, title: 'codex', launchAgent: 'codex' })
    await act(async () => {
      useAppStore.setState({ agentStatusByPaneKey: {} })
    })
    await render({ ...tab, title: 'MINGW64:/c/Users/me/proj', launchAgent: 'codex' }, root)
    expect(latest).toBe('codex')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })

  it('clears launch intent when the focused identified owner exits', async () => {
    splitLayout()
    useAppStore.setState({
      agentPresenceByPaneKey: { [FOCUSED]: { presence: { ...claude, ended: true }, receivedAt: 1 } }
    })
    await render({ ...tab, title: '✳ Claude Code', launchAgent: 'claude' })
    expect(latest).toBeNull()
    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it.each([true, false])(
    'clears the icon once Claude exits and leaves its own evidence behind, identified=%s',
    async (identified) => {
      splitLayout()
      useAppStore.setState({
        agentStatusByPaneKey: {
          [FOCUSED]: { ...codexRow(FOCUSED), state: 'done', agentType: 'claude' }
        },
        sleepingAgentSessionsByPaneKey: {
          [FOCUSED]: {
            paneKey: FOCUSED,
            worktreeId: 'wt-1',
            agent: 'claude',
            providerSession: { key: 'session_id', id: 's-1' },
            prompt: '',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1
          }
        },
        ...(identified
          ? {
              agentPresenceByPaneKey: {
                [FOCUSED]: { presence: { ...claude, ended: true }, receivedAt: 1 }
              }
            }
          : {})
      })
      await render({ ...tab, title: '✳ Claude Code' })
      // A pane that never had an identified owner keeps main's guess from the same leftovers.
      expect(latest).toBe(identified ? null : 'claude')
    }
  )

  it('shows a later hookless Claude once the shell is back in the exited owner pane', async () => {
    splitLayout()
    useAppStore.setState({
      agentPresenceByPaneKey: {
        [FOCUSED]: { presence: { ...claude, ended: true }, receivedAt: 1 }
      },
      paneForegroundAgentByPaneKey: {
        [FOCUSED]: { agent: 'claude', agentEvidence: 'process-read', shellForeground: false }
      }
    })
    const root = await render({ ...tab, title: 'orca' })
    expect(latest).toBeNull()
    await act(async () => {
      useAppStore.getState().retireEndedAgentPresence(FOCUSED)
    })
    await render({ ...tab, title: 'orca' }, root)
    expect(latest).toBe('claude')
  })
})
