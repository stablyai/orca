import type { AppState } from '../../types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { findTabAndWorktree } from '../tab-group-state'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export function patchTerminalTabPinned(
  tabsByWorktree: Record<string, TerminalTab[]>,
  worktreeId: string,
  tabId: string,
  isPinned: boolean
): Partial<Pick<AppState, 'tabsByWorktree'>> {
  const tabs = tabsByWorktree[worktreeId]
  if (!tabs?.some((tab) => tab.id === tabId)) {
    return {}
  }
  return {
    tabsByWorktree: {
      ...tabsByWorktree,
      [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, isPinned } : tab))
    }
  }
}

// Why: pin is host-authoritative for remote-server tabs, so mirror it (like setTabColor) or it's lost on reconnect/other clients.
// Dynamic import keeps this store slice off the runtime layer.
export function mirrorTabPinnedToHost(state: AppState, tabId: string, isPinned: boolean): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Why: only terminal tab pins are persisted host-side today (browser/editor in #5729); skip the RPC for other types.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !getRuntimeEnvironmentIdForWorktree(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, isPinned })
  )
}

// Why: viewMode is host-tracked like color/pin, so mirror local sets or they're lost on reconnect and to paired clients.
// Only the action path mirrors (never reconcile applying a host value), so the echoed snapshot can't re-trigger an outbound RPC.
export function mirrorTabViewModeToHost(
  state: AppState,
  tabId: string,
  viewMode: 'terminal' | 'chat'
): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Why: only terminal tab viewMode is persisted host-side; skip the RPC for other types instead of a no-op round trip.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !getRuntimeEnvironmentIdForWorktree(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, viewMode })
  )
}

// Why: every other tab kind has a host-owned rename channel — a terminal's goes through
// `terminal.rename` on its pty handle — but a structured chat has no pty, so its name lived
// only in this client's `customLabel` and never reached the phone, the web client, or a second
// desktop. The chat tab is host-owned even on a local workspace (the renderer publishes no
// agent-session tab; the host's copy is the only one a paired client sees), so the host must
// hear the rename.
export function mirrorTabCustomTitleToHost(
  state: AppState,
  tabId: string,
  title: string | null
): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  if (!found || found.tab.contentType !== 'agent-session') {
    return
  }
  const { worktreeId, tab } = found
  if (getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
      setWebRuntimeTabProps({ worktreeId, tabId, title })
    )
    return
  }
  void setLocalStructuredSessionTabName(worktreeId, tab.entityId, title)
}

async function setLocalStructuredSessionTabName(
  worktreeId: string,
  sessionId: string,
  title: string | null
): Promise<void> {
  const [{ callRuntimeRpc }, { toRuntimeWorktreeSelector }, { structuredAgentSessionHostTabId }] =
    await Promise.all([
      import('@/runtime/runtime-rpc-client'),
      import('@/runtime/runtime-worktree-selector'),
      import('../../../../../shared/runtime-mobile-session-tab-contracts')
    ])
  await callRuntimeRpc<{ updated: true }>({ kind: 'local' }, 'session.tabs.setTabProps', {
    worktree: toRuntimeWorktreeSelector(worktreeId),
    tabId: structuredAgentSessionHostTabId(sessionId),
    title
  }).catch((error) => {
    console.warn(
      '[tabs-host-mirroring] failed to publish the chat tab name:',
      error instanceof Error ? error.message : String(error)
    )
  })
}
