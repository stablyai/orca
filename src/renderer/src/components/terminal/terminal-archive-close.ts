import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { translate } from '@/i18n/i18n'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { useAppStore } from '@/store'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import type {
  TerminalArchiveReason,
  TerminalLostWorkerRendererReceipt
} from '../../../../shared/terminal-archive-types'

export type TerminalArchiveCloseReceipt = {
  archiveId: string
  topologyFingerprint: string
}

export function canArchiveTerminalTabClose(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.pty?.archiveTerminalTab === 'function'
}

export function terminalArchiveCloseUnavailableError(): Error {
  return new Error(
    translate(
      'auto.components.terminal.terminal.archive.close.d45b935f2b',
      'Terminal archive protection is unavailable. Keep this tab open and reload Orca.'
    )
  )
}

function topologyFingerprint(tabId: string): string {
  const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
  return JSON.stringify({
    root: layout?.root ?? null,
    ptyIdsByLeafId: Object.entries(layout?.ptyIdsByLeafId ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  })
}

export function isTerminalArchiveTopologyCurrent(
  tabId: string,
  expectedFingerprint: string
): boolean {
  return topologyFingerprint(tabId) === expectedFingerprint
}

export async function archiveTerminalTabBeforeRetirement(
  tabId: string,
  worktreeId: string
): Promise<TerminalArchiveCloseReceipt> {
  // Why: xterm is the only complete SSH scrollback source before the provider is retired.
  shutdownBufferCaptures.get(tabId)?.({ includeLocalBuffers: true })
  const state = useAppStore.getState()
  const routing = resolveWorktreeOperationRouteResult(state, worktreeId)
  const executionHostId =
    (routing.kind === 'resolved' ? routing.route.executionHostId : null) ??
    getExecutionHostIdForWorktree(state, worktreeId) ??
    'local'
  const layout = state.terminalLayoutsByTabId[tabId]
  const expectedTopologyFingerprint = topologyFingerprint(tabId)
  const snapshotsByLeafId = Object.fromEntries(
    Object.entries(layout?.buffersByLeafId ?? {}).map(([leafId, buffer]) => [
      leafId,
      {
        buffer,
        source: 'renderer' as const,
        truncated: false,
        byteLength: getUtf8ByteLength(buffer)
      }
    ])
  )
  const session = {
    ...buildWorkspaceSessionPayload(state),
    // Archive capture retains local bytes that ordinary session persistence intentionally drops.
    terminalLayoutsByTabId: state.terminalLayoutsByTabId
  }
  const result = await window.api.pty.archiveTerminalTab({
    session,
    worktreeId,
    tabId,
    executionHostId,
    ...(routing.kind === 'resolved' && routing.route.runtimeEnvironmentId
      ? { runtimeEnvironmentId: routing.route.runtimeEnvironmentId }
      : {}),
    snapshotsByLeafId
  })
  return { archiveId: result.archiveId, topologyFingerprint: expectedTopologyFingerprint }
}

/** Main decides whether this established terminal was a worker before any fallback clears it. */
export async function handleLostTerminalCandidate(args: {
  tabId: string
  worktreeId: string
  leafId: string
  reason: Exclude<TerminalArchiveReason, 'user-close'>
}): Promise<TerminalLostWorkerRendererReceipt> {
  shutdownBufferCaptures.get(args.tabId)?.({ includeLocalBuffers: true })
  const state = useAppStore.getState()
  const routing = resolveWorktreeOperationRouteResult(state, args.worktreeId)
  const executionHostId =
    (routing.kind === 'resolved' ? routing.route.executionHostId : null) ??
    getExecutionHostIdForWorktree(state, args.worktreeId) ??
    'local'
  const layout = state.terminalLayoutsByTabId[args.tabId]
  const snapshotsByLeafId = Object.fromEntries(
    Object.entries(layout?.buffersByLeafId ?? {}).map(([leafId, buffer]) => [
      leafId,
      {
        buffer,
        source: 'renderer' as const,
        truncated: false,
        byteLength: getUtf8ByteLength(buffer)
      }
    ])
  )
  const handler = window.api.pty.handleLostTerminalCandidate
  if (typeof handler !== 'function') {
    throw new Error('terminal_lost_worker_handoff_unavailable')
  }
  try {
    return await handler({
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: args.leafId,
      reason: args.reason,
      executionHostId,
      ...(routing.kind === 'resolved' && routing.route.runtimeEnvironmentId
        ? { runtimeEnvironmentId: routing.route.runtimeEnvironmentId }
        : {}),
      snapshotsByLeafId
    })
  } catch {
    return { kind: 'retryable-error', code: 'durability-failed' }
  }
}
