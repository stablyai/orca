// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab, TuiAgent } from '../../../shared/types'
import { useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const FOCUSED_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
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
  createdAt: 1,
  launchAgent: 'claude'
}

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestAgent = useTabAgent(tab)
  return null
}

function statusEntry(paneKey: string, agentType: AgentType, state: AgentStatusEntry['state']) {
  return {
    paneKey,
    agentType,
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  } satisfies AgentStatusEntry
}

function retainedEntry(paneKey: string, agentType: AgentType): RetainedAgentEntry {
  return {
    entry: statusEntry(paneKey, agentType, 'done'),
    worktreeId: WORKTREE_ID,
    tab: baseTab,
    agentType,
    startedAt: 1
  }
}

function layout(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: FOCUSED_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [FOCUSED_LEAF_ID]: 'pty-focused',
      [SIBLING_LEAF_ID]: 'pty-sibling'
    }
  }
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

describe('useTabAgent retained completion identity', () => {
  beforeEach(() => {
    latestAgent = undefined
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { [TAB_ID]: ['pty-focused', 'pty-sibling'] },
      terminalLayoutsByTabId: { [TAB_ID]: layout() },
      agentStatusByPaneKey: {},
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

  it('uses focused retained Codex identity over stale Claude launch metadata', async () => {
    const paneKey = makePaneKey(TAB_ID, FOCUSED_LEAF_ID)
    useAppStore.setState({
      retainedAgentsByPaneKey: { [paneKey]: retainedEntry(paneKey, 'codex') }
    })

    await renderProbe()

    expect(latestAgent).toBe('codex')
  })

  it('keeps a live focused hook ahead of retained identity', async () => {
    const paneKey = makePaneKey(TAB_ID, FOCUSED_LEAF_ID)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [paneKey]: statusEntry(paneKey, 'gemini', 'working')
      },
      retainedAgentsByPaneKey: { [paneKey]: retainedEntry(paneKey, 'codex') }
    })

    await renderProbe()

    expect(latestAgent).toBe('gemini')
  })

  it('lets an explicit cross-agent title reclaim a retained idle pane', async () => {
    const paneKey = makePaneKey(TAB_ID, FOCUSED_LEAF_ID)
    useAppStore.setState({
      retainedAgentsByPaneKey: { [paneKey]: retainedEntry(paneKey, 'codex') }
    })

    await renderProbe({ ...baseTab, launchAgent: 'codex', title: '✳ Claude Code' })

    expect(latestAgent).toBe('claude')
  })

  it('keeps focused launch metadata ahead of sibling retained identity', async () => {
    const paneKey = makePaneKey(TAB_ID, SIBLING_LEAF_ID)
    useAppStore.setState({
      retainedAgentsByPaneKey: { [paneKey]: retainedEntry(paneKey, 'codex') }
    })

    await renderProbe()

    expect(latestAgent).toBe('claude')
  })
})
