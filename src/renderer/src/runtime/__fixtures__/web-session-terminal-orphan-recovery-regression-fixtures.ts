import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import { toRemoteRuntimePtyId } from '../runtime-terminal-stream'
import type { TerminalOrphanRecoveryState } from '../web-session-terminal-orphan-recovery-surface'

export const ENVIRONMENT_ID = 'remote-runtime'

export type LeafSpec = {
  leafId: string
  handle: string
  incoming?: Record<string, unknown>
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function makeState(
  worktree: string,
  leaves: readonly LeafSpec[]
): TerminalOrphanRecoveryState {
  const localTabId = 'web-terminal-host-tab'
  const ptyIdsByLeafId = Object.fromEntries(
    leaves.map((leaf) => [leaf.leafId, toRemoteRuntimePtyId(leaf.handle, ENVIRONMENT_ID)])
  )
  const root =
    leaves.length === 1
      ? { type: 'leaf' as const, leafId: leaves[0]!.leafId }
      : {
          type: 'split' as const,
          direction: 'horizontal' as const,
          ratio: 0.5,
          first: { type: 'leaf' as const, leafId: leaves[0]!.leafId },
          second: { type: 'leaf' as const, leafId: leaves[1]!.leafId }
        }
  return {
    tabsByWorktree: {
      [worktree]: [
        {
          id: localTabId,
          ptyId: Object.values(ptyIdsByLeafId)[0] ?? null,
          worktreeId: worktree,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [localTabId]: {
        root,
        activeLeafId: leaves[0]!.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId
      }
    },
    activeTabIdByWorktree: { [worktree]: localTabId },
    activeGroupIdByWorktree: {}
  }
}

export function makeSnapshot(
  worktree: string,
  publicationEpoch: string,
  leaves: readonly LeafSpec[]
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch,
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: leaves.flatMap((leaf) => (leaf.incoming ? [leaf.incoming] : [])) as never
  }
}

export function listResult(
  worktree: string,
  terminals: readonly Record<string, unknown>[],
  options: { truncated?: boolean; hostScope?: Record<string, unknown> | undefined } = {}
) {
  return {
    terminals,
    topologyRevisions: { [worktree]: 7 },
    totalCount: terminals.length,
    truncated: options.truncated ?? false,
    ...(options.hostScope === undefined
      ? { hostScope: { hostIds: [ENVIRONMENT_ID], omittedHostIds: [] } }
      : { hostScope: options.hostScope })
  }
}

export function pendingSurface(
  tabId: string,
  leafId: string,
  ptyId: string,
  terminal: string | null = null
): RuntimeMobileSessionTerminalClientTab {
  if (terminal !== null) {
    return {
      type: 'terminal',
      id: `${tabId}::${leafId}`,
      parentTabId: tabId,
      leafId,
      title: leafId,
      ptyId,
      isActive: false,
      status: 'ready',
      terminal
    }
  }
  return {
    type: 'terminal',
    id: `${tabId}::${leafId}`,
    parentTabId: tabId,
    leafId,
    title: leafId,
    ptyId,
    isActive: false,
    status: 'pending-handle',
    terminal: null
  }
}
