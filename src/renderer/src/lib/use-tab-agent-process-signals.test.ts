// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/agent-status/identity/terminal-agent'
import '../../../shared/tab-agent-from-signals'
import { useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
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
  return root
}

async function setPaneForeground(entry: PaneForegroundAgentEntry): Promise<void> {
  await act(async () => {
    useAppStore.getState().setPaneForegroundAgent(PANE_KEY, entry)
  })
}

describe('useTabAgent process signals', () => {
  const clearTabLaunchAgent = vi.fn()
  const baseTab: TerminalTab = {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }

  beforeEach(() => {
    latestHookAgent = undefined
    clearTabLaunchAgent.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      agentStatusByPaneKey: {},
      clearTabLaunchAgent
    })
  })

  afterEach(() => {
    hookRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('shows the recognized foreground agent for a manual launch with no hooks or titles', async () => {
    await renderHookProbe(baseTab)
    expect(latestHookAgent).toBeNull()

    await setPaneForeground({ agent: 'aider', shellForeground: false })

    expect(latestHookAgent).toBe('aider')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })

  it('clears hookless launch identity on shell-foreground evidence despite a stale title', async () => {
    const launchedTab = { ...baseTab, launchAgent: 'aider' as const, title: '⠸ aider working' }
    const root = await renderHookProbe(launchedTab)

    await setPaneForeground({ agent: 'aider', shellForeground: false })
    expect(latestHookAgent).toBe('aider')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()

    // OSC 133;D proves launched-command exit; stale spinner titles cannot retain identity.
    await setPaneForeground({ agent: null, shellForeground: true })
    await act(async () => {
      root.render(createElement(HookProbe, { tab: launchedTab }))
    })

    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it('does not clear launch identity from shell foreground before any agent activity', async () => {
    const launchedTab = { ...baseTab, launchAgent: 'aider' as const }
    await renderHookProbe(launchedTab)

    // Pre-start shell/setup completion cannot prove the launched agent ever ran.
    await setPaneForeground({ agent: null, shellForeground: true })

    expect(latestHookAgent).toBe('aider')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })
})
