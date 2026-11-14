// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { create } from 'zustand'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { withAgentStatusOwnership } from '@/store/slices/agent-status/agent-status-ownership-boundary'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { useTerminalPaneTabState } from '../controller/use-terminal-pane-tab-state'
import { useTerminalTabAgentTypes } from '../titles/use-terminal-tab-agent-types'
import {
  acceptedAgentStatuses,
  AcceptedAgentStatuses
} from '@/store/slices/agent-status/accepted-agent-statuses'
import { AgentStatusProjection } from '@/store/slices/agent-status/agent-status-projection'
import { useTerminalPaneChatProjection } from './use-terminal-pane-chat-projection'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const PANES = {
  a: { tabId: 'tab-a', leafId: '11111111-1111-4111-8111-111111111111', worktreeId: 'wt-a' },
  b: { tabId: 'tab-b', leafId: '22222222-2222-4222-8222-222222222222', worktreeId: 'wt-b' }
}
type Pane = keyof typeof PANES

function projectionArgs(pane: Pane): Parameters<typeof useTerminalPaneChatProjection>[0] {
  const { tabId, leafId, worktreeId } = PANES[pane]
  const args = {
    applyNativeChatLeafRoute: () => {},
    canToggleChatForLeaf: () => false,
    chatLeafId: null,
    contextMenu: { open: true },
    contextMenuLeafId: leafId,
    effectiveChatViewMode: false,
    getContextMenuLeafId: () => leafId,
    getNativeChatLeafIds: () => [leafId],
    getTabWideAgentHintLeafId: () => null,
    isChatEligibleForLeaf: () => false,
    isChatViewMode: false,
    toggleNativeChatForLeaf: () => {},
    paneTransportsRef: { current: new Map() },
    resolveTitleAgentForLeaf: () => null,
    tabId,
    tabAgentTypeByLeaf: {},
    terminalTab: undefined,
    worktreeId,
    activePane: undefined,
    managedPanes: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields of its pane controller; the rest of the controller is unused here.
  return args as unknown as Parameters<typeof useTerminalPaneChatProjection>[0]
}

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

it('re-renders a pane for its own Agent ID availability only', () => {
  const original = useAppStore.getState()
  const renders = { a: 0, b: 0 }
  const offered: Record<Pane, boolean | null> = { a: null, b: null }
  function Probe({ pane }: { pane: Pane }) {
    renders[pane]++
    const { tabAgentTypeByLeaf } = useTerminalPaneTabState(PANES[pane])
    offered[pane] = useTerminalPaneChatProjection({
      ...projectionArgs(pane),
      tabAgentTypeByLeaf
    }).menuAgentIdAvailable
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    act(() =>
      root.render(
        <>
          <Probe pane="a" />
          <Probe pane="b" />
        </>
      )
    )
    act(() => reportStatus('a', 'claude_a_identity', 1_000))
    act(() => reportStatus('b', undefined, 1_000))
    const settled = { ...renders }
    expect(offered).toEqual({ a: true, b: false })

    // Pane b's host now stamps the field (null: named later): only b re-renders, and flips.
    act(() => reportStatus('b', null, 2_000))
    expect(renders).toEqual({ a: settled.a, b: settled.b + 1 })
    expect(offered).toEqual({ a: true, b: true })

    // b's id resolves: availability is unchanged, so neither pane re-renders.
    act(() => reportStatus('b', 'claude_b_identity', 3_000))
    expect(renders).toEqual({ a: settled.a, b: settled.b + 1 })

    // Another host's status/capabilities change: no pane re-renders.
    act(() =>
      useAppStore.getState().setRuntimeEnvironmentStatus('other-host', {
        status: null,
        checkedAt: 4_000,
        snapshot: {
          environmentId: 'other-host',
          pairingRevision: 1,
          checkedAt: 4_000,
          sequence: 1,
          status: null,
          verification: 'unavailable',
          transport: 'ready'
        }
      })
    )
    expect(renders).toEqual({ a: settled.a, b: settled.b + 1 })
  } finally {
    act(() => root.unmount())
    useAppStore.setState(original, true)
  }
})

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

it.each([100, 1000])('addresses only the changed title among %i mounted tabs', (count) => {
  const original = useAppStore.getState()
  const root = createRoot(document.createElement('div'))
  const renders = Array.from({ length: count }, () => 0)
  const types: Readonly<Record<string, string>>[] = []
  const leafId = PANES.a.leafId
  function Probe({ index }: { index: number }) {
    renders[index]++
    types[index] = useTerminalTabAgentTypes(`fleet-${index}`)
    return null
  }
  try {
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(
        Array.from({ length: count - 1 }, (_, i): readonly [string, AgentStatusEntry] => {
          const paneKey = `fleet-${i + 1}:${leafId}`
          return [
            paneKey,
            {
              paneKey,
              agentType: 'claude',
              state: 'done',
              prompt: 'Finished task',
              updatedAt: 1_000,
              stateStartedAt: 1_000,
              stateHistory: [],
              paneSleep: { ptyId: `sleep-${i + 1}` }
            }
          ]
        })
      ),
      paneForegroundAgentByPaneKey: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `fleet-${i}:${leafId}`,
          { agent: 'codex', shellForeground: false }
        ])
      )
    })
    act(() =>
      root.render(Array.from({ length: count }, (_, index) => <Probe key={index} index={index} />))
    )
    expect(types[0]).toEqual({ [leafId]: 'codex' })
    const settled = [...renders]
    const materializations = vi.spyOn(AgentStatusProjection.prototype, 'terminalLeafAgentTypes')
    const reads = vi.spyOn(AcceptedAgentStatuses.prototype, 'get')
    const target = `fleet-0:${leafId}`
    act(() =>
      useAppStore
        .getState()
        .setPaneForegroundAgent(target, { agent: 'claude', shellForeground: false })
    )
    expect(types[0]).toEqual({ [leafId]: 'claude' })
    expect(renders.slice(1)).toEqual(settled.slice(1))
    expect(materializations.mock.calls.every(([tab]) => tab === 'fleet-0')).toBe(true)
    expect(reads.mock.calls.every(([key]) => key === target)).toBe(true)
    materializations.mockClear()
    reads.mockClear()
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(target, { state: 'working', agentType: 'unknown', prompt: 'Task' })
    )
    expect(types[0]).toEqual({ [leafId]: 'unknown' })
    expect(renders.slice(1)).toEqual(settled.slice(1))
    expect(materializations.mock.calls.every(([tab]) => tab === 'fleet-0')).toBe(true)
    expect(reads.mock.calls.every(([key]) => key === target)).toBe(true)
    const acceptedRender = renders[0]
    materializations.mockClear()
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(target, { state: 'working', agentType: 'unknown', prompt: 'More detail' })
    )
    expect(renders[0]).toBe(acceptedRender)
    expect(materializations).not.toHaveBeenCalled()
    act(() => useAppStore.getState().dropAgentStatus(target))
    expect(types[0]).toEqual({ [leafId]: 'claude' })
    const captured = useAppStore.getState().agentStatusByPaneKey.capture()
    const own = renders[0]
    materializations.mockClear()
    act(() =>
      useAppStore.getState().setPaneForegroundAgent(target, {
        agent: 'claude',
        shellForeground: false,
        routingTrusted: true
      })
    )
    expect(renders[0]).toBe(own)
    expect(materializations).not.toHaveBeenCalled()
    act(() => useAppStore.getState().clearPaneForegroundAgent(target))
    expect(types[0]).toEqual({})
    expect(captured.projection.terminalLeafAgentTypes('fleet-0')).toEqual({ [leafId]: 'claude' })
  } finally {
    vi.restoreAllMocks()
    act(() => root.unmount())
    useAppStore.setState(original, true)
  }
})

it('seeds foreground-only title identity at the actual cold ownership boundary', () => {
  const { tabId, leafId } = PANES.a
  const store = create<AppState>()(
    withAgentStatusOwnership(() => ({
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
