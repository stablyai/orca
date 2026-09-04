// @vitest-environment happy-dom

/**
 * Pins the store reads `useTabAgent` does through the FOCUSED pane key —
 * foreground-process identity, OSC 133;D shell evidence — and the remote verdict
 * it derives from the tab's worktree. The identity precedence itself is pinned by
 * `use-tab-agent.test.ts`; this file exists so a change to HOW those values are
 * selected (bundled, rekeyed, memoized) cannot quietly move WHICH pane they come from.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const FOCUSED_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const REPO_ID = 'repo-1'
const FOCUSED_PANE = makePaneKey(TAB_ID, FOCUSED_LEAF_ID)
const SIBLING_PANE = makePaneKey(TAB_ID, SIBLING_LEAF_ID)

let latestAgent: TuiAgent | null | undefined
let root: Root | null = null

const baseTab: TerminalTab = {
  id: TAB_ID,
  ptyId: 'pty-focused',
  worktreeId: WORKTREE_ID,
  title: 'Terminal 1',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestAgent = useTabAgent(tab)
  return null
}

function layoutFocusedOn(activeLeafId: string): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [FOCUSED_LEAF_ID]: 'pty-focused',
      [SIBLING_LEAF_ID]: 'pty-sibling'
    }
  }
}

function foreground(agent: TuiAgent | null, shellForeground = false): PaneForegroundAgentEntry {
  return { agent, shellForeground }
}

function doneStatus(paneKey: string, agentType: AgentType): AgentStatusEntry {
  return {
    paneKey,
    agentType,
    state: 'done',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
}

function sleepingRecord(agent: TuiAgent): SleepingAgentSessionRecord {
  return { agent } as unknown as SleepingAgentSessionRecord
}

/** A repo whose worktree the tab lives in; `connectionId` is what makes it remote. */
function seedWorkspace(connectionId?: string): void {
  useAppStore.setState({
    repos: [{ id: REPO_ID, connectionId } as unknown as Repo],
    worktreesByRepo: {
      [REPO_ID]: [{ id: WORKTREE_ID, repoId: REPO_ID } as unknown as Worktree]
    }
  })
}

async function renderProbe(tab: TerminalTab = baseTab): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(HookProbe, { tab }))
    await Promise.resolve()
  })
}

async function setState(partial: Partial<AppState>): Promise<void> {
  await act(async () => {
    useAppStore.setState(partial)
    await Promise.resolve()
  })
}

describe('useTabAgent focused-pane store signals', () => {
  beforeEach(() => {
    latestAgent = undefined
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { [TAB_ID]: ['pty-focused', 'pty-sibling'] },
      terminalLayoutsByTabId: { [TAB_ID]: layoutFocusedOn(FOCUSED_LEAF_ID) },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      clearTabLaunchAgent: vi.fn()
    })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('takes foreground identity from the focused pane and ignores a sibling pane', async () => {
    await setState({ paneForegroundAgentByPaneKey: { [SIBLING_PANE]: foreground('aider') } })
    await renderProbe()
    expect(latestAgent).toBeNull()

    await setState({
      paneForegroundAgentByPaneKey: {
        [SIBLING_PANE]: foreground('aider'),
        [FOCUSED_PANE]: foreground('codex')
      }
    })
    expect(latestAgent).toBe('codex')
  })

  it('follows the active leaf when the focused pane changes', async () => {
    await setState({
      paneForegroundAgentByPaneKey: {
        [FOCUSED_PANE]: foreground('codex'),
        [SIBLING_PANE]: foreground('aider')
      }
    })
    await renderProbe()
    expect(latestAgent).toBe('codex')

    await setState({
      terminalLayoutsByTabId: { [TAB_ID]: layoutFocusedOn(SIBLING_LEAF_ID) }
    })
    expect(latestAgent).toBe('aider')
  })

  it('takes the sleeping-session record from the focused pane, not a sibling', async () => {
    await setState({
      sleepingAgentSessionsByPaneKey: { [SIBLING_PANE]: sleepingRecord('gemini') }
    })
    await renderProbe()
    expect(latestAgent).toBeNull()

    await setState({
      sleepingAgentSessionsByPaneKey: { [FOCUSED_PANE]: sleepingRecord('gemini') }
    })
    expect(latestAgent).toBe('gemini')
  })

  /**
   * The same store shape resolves two ways: OSC 133;D is exit evidence on a local
   * pane, and no evidence at all on a remote one whose title lags the runtime.
   * Remoteness comes from the repo behind `tab.worktreeId`, so this also pins that read.
   */
  it('lets focused shell-foreground retire idle identity locally but not on a remote worktree', async () => {
    seedWorkspace()
    await setState({
      agentStatusByPaneKey: { [FOCUSED_PANE]: doneStatus(FOCUSED_PANE, 'codex') },
      paneForegroundAgentByPaneKey: { [FOCUSED_PANE]: foreground(null, true) }
    })
    await renderProbe()
    expect(latestAgent).toBeNull()

    if (root) {
      act(() => root?.unmount())
      root = null
    }
    seedWorkspace('ssh-target-1')
    await renderProbe()
    expect(latestAgent).toBe('codex')
  })
})
