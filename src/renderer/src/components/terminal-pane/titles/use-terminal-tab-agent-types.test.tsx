// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { create } from 'zustand'
import type { AppState } from '@/store/types'
import { withStatusTransaction } from '@/store/status-transaction/status-transaction-boundary'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { useTerminalPaneTabState } from '../controller/use-terminal-pane-tab-state'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const PANES = {
  a: { tabId: 'tab-a', leafId: '11111111-1111-4111-8111-111111111111', worktreeId: 'wt-a' },
  b: { tabId: 'tab-b', leafId: '22222222-2222-4222-8222-222222222222', worktreeId: 'wt-b' }
}
type Pane = keyof typeof PANES

function reportStatus(pane: Pane, orcaSessionId: string | null | undefined, at: number): void {
  const { tabId, leafId, worktreeId } = PANES[pane]
  useAppStore.getState().setAgentStatus(
    makePaneKey(tabId, leafId),
    { state: 'working', agentType: 'claude', prompt: 'p' },
    undefined,
    { updatedAt: at, stateStartedAt: at },
    { tabId, worktreeId },
    {
      providerSession: { key: 'session_id', id: `session-${pane}` },
      ...(orcaSessionId !== undefined ? { orcaSessionId } : {})
    }
  )
}

it('keeps raw leaf identity through explicit precedence, foreground fallback and removal', () => {
  const original = useAppStore.getState()
  const { tabId, leafId } = PANES.a
  const key = makePaneKey(tabId, leafId)
  let types: Readonly<Record<string, string>> = {}
  function Probe() {
    types = useTerminalPaneTabState(PANES.a).tabAgentTypeByLeaf
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(),
      paneForegroundAgentByPaneKey: {}
    })
    act(() => root.render(<Probe />))
    expect(types).toEqual({})
    // An unplaced foreground pane still supplies its own raw agent identity.
    act(() =>
      useAppStore.getState().setPaneForegroundAgent(key, { agent: 'codex', shellForeground: false })
    )
    expect(types).toEqual({ [leafId]: 'codex' })
    act(() => reportStatus('a', undefined, 1_000))
    expect(types).toEqual({ [leafId]: 'claude' })
    act(() => useAppStore.getState().dropAgentStatus(key))
    expect(types).toEqual({ [leafId]: 'codex' })
    act(() =>
      useAppStore.getState().setPaneForegroundAgent(key, {
        agent: 'codex',
        shellForeground: false,
        routingRevoked: true
      })
    )
    expect(types).toEqual({})
    act(() =>
      useAppStore.getState().setPaneForegroundAgent(key, { agent: 'codex', shellForeground: false })
    )
    act(() => useAppStore.getState().clearPaneForegroundAgent(key))
    expect(types).toEqual({})
  } finally {
    act(() => root.unmount())
    useAppStore.setState(original, true)
  }
})

it('seeds foreground-only title identity at the actual cold ownership boundary', () => {
  const { tabId, leafId } = PANES.a
  const store = create<AppState>()(
    withStatusTransaction(() => ({
      ...useAppStore.getState(),
      agentStatusByPaneKey: acceptedAgentStatuses(),
      paneForegroundAgentByPaneKey: {
        [makePaneKey(tabId, leafId)]: { agent: 'codex', shellForeground: false }
      }
    }))
  )
  expect(store.getState().agentStatusByPaneKey.projection.terminalLeafAgentTypes(tabId)).toEqual({
    [leafId]: 'codex'
  })
})
