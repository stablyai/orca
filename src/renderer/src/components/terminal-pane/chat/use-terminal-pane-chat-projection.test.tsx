// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
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
    offered[pane] = useTerminalPaneChatProjection(projectionArgs(pane)).menuAgentIdAvailable
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
