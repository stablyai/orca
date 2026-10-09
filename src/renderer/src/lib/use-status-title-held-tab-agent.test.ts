// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { useStatusTitleHeldTabAgent } from './use-status-title-held-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'tab-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
// Captured in #24315: Claude Code 2.1.286 alternates these titles about every 0.9 s mid-turn.
const SPINNER_TITLE_A = '◐ Fix the auth bug'
const SPINNER_TITLE_B = '◑ Fix the auth bug'

let latestAgent: TerminalAgent | null | undefined
let root: Root | null = null

// Typed `claude` at a shell: no launch intent, so the hook row is the only identity source.
const baseTab: TerminalTab = {
  id: TAB_ID,
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  title: SPINNER_TITLE_A,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestAgent = useStatusTitleHeldTabAgent(tab)
  return null
}

function workingClaudeRow(): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    agentType: 'claude',
    state: 'working',
    prompt: 'Fix the auth bug',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
}

function layout(ptyId = 'pty-1'): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId }
  }
}

async function render(tab: TerminalTab): Promise<void> {
  if (!root) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(createElement(HookProbe, { tab }))
    await Promise.resolve()
  })
}

async function dropHookRow(): Promise<void> {
  await act(async () => {
    useAppStore.setState({ agentStatusByPaneKey: {} })
    await Promise.resolve()
  })
}

describe('useStatusTitleHeldTabAgent (#24315)', () => {
  beforeEach(() => {
    latestAgent = undefined
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
      terminalLayoutsByTabId: { [TAB_ID]: layout() },
      agentStatusByPaneKey: { [PANE_KEY]: workingClaudeRow() },
      retainedAgentsByPaneKey: {},
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

  it('keeps the Claude icon when the hook row drops mid-turn while the title still spins', async () => {
    await render(baseTab)
    expect(latestAgent).toBe('claude')

    await dropHookRow()
    await render({ ...baseTab, title: SPINNER_TITLE_B })

    expect(latestAgent).toBe('claude')
  })

  it('follows the hook row again once it returns', async () => {
    await render(baseTab)
    await dropHookRow()
    await render({ ...baseTab, title: SPINNER_TITLE_B })
    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: { [PANE_KEY]: { ...workingClaudeRow(), agentType: 'codex' } }
      })
      await Promise.resolve()
    })

    expect(latestAgent).toBe('codex')
  })

  it('never labels a plain terminal from a spinner-shaped title alone', async () => {
    useAppStore.setState({ agentStatusByPaneKey: {} })

    await render(baseTab)

    expect(latestAgent).toBeNull()
  })

  it('lets go once the title stops carrying a status glyph', async () => {
    await render(baseTab)
    await dropHookRow()
    await render({ ...baseTab, title: 'pwsh' })
    expect(latestAgent).toBeNull()

    // The hold must not come back on a later spinner frame without fresh evidence.
    await render({ ...baseTab, title: SPINNER_TITLE_B })
    expect(latestAgent).toBeNull()
  })

  it('lets go when the local shell reports it is back in the foreground', async () => {
    await render(baseTab)
    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: {
          [PANE_KEY]: { agent: null, shellForeground: true }
        }
      })
      await Promise.resolve()
    })

    expect(latestAgent).toBeNull()
  })

  it('lets go once the process reader confirms the agent it saw has exited', async () => {
    useAppStore.setState({
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: 'claude', agentEvidence: 'process-read', shellForeground: false }
      }
    })
    await render(baseTab)
    expect(latestAgent).toBe('claude')

    // Mirrors pane-foreground-agent-tracker's onProcessExitConfirmed publish.
    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: { [PANE_KEY]: { agent: null, shellForeground: false } }
      })
      await Promise.resolve()
    })

    expect(latestAgent).toBeNull()
  })

  it('does not hold on an idle status glyph, only a working spinner', async () => {
    await render({ ...baseTab, title: '\u2733 Fix the auth bug' })
    await dropHookRow()

    expect(latestAgent).toBeNull()
  })

  it("does not pin a sibling pane's agent onto the focused plain terminal", async () => {
    const siblingPaneKey = makePaneKey(TAB_ID, SIBLING_LEAF_ID)
    useAppStore.setState({
      ptyIdsByTabId: { [TAB_ID]: ['pty-1', 'pty-2'] },
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          ...layout(),
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1', [SIBLING_LEAF_ID]: 'pty-2' }
        }
      },
      agentStatusByPaneKey: {
        [siblingPaneKey]: { ...workingClaudeRow(), paneKey: siblingPaneKey, agentType: 'codex' }
      }
    })
    await render({ ...baseTab, title: '\u25D0 download' })
    expect(latestAgent).toBe('codex')

    await dropHookRow()

    expect(latestAgent).toBeNull()
  })

  it('lets go when the pane respawns onto a new PTY', async () => {
    await render(baseTab)
    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: {},
        ptyIdsByTabId: { [TAB_ID]: ['pty-2'] },
        terminalLayoutsByTabId: { [TAB_ID]: layout('pty-2') }
      })
      await Promise.resolve()
    })

    expect(latestAgent).toBeNull()
  })
})
