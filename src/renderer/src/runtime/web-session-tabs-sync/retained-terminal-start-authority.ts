import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import type { TerminalPaneStart } from '@/store/terminals/terminal-state'
import { TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-runtime-capabilities'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '../rpc/environment-revisions/runtime-environment-revision'
import { peekRuntimeEnvironmentCapability } from '../rpc/compatibility/runtime-compatibility-cache'
import { hostSnapshotAffirmsWorktreeContents } from './hydration/host-session-snapshot-authority'
import {
  isCurrentSessionTabsRuntimeId,
  isRetiredSessionTabsRuntimeId
} from './publisher-identity-fences'
import { shouldApplyRecoveredWebSessionTabsSnapshot } from './tracking'

export type RetainedTerminalSnapshotAuthority = {
  environmentId: string
  runtimeId: string
  worktreeId: string
  pairingRevision: number | undefined
  receivedFrame: number
  retainsStarts: boolean | undefined
}

// Snapshot-local acceptance provenance dies with its publication; it is not a pane fact cache.
const acceptedSnapshots = new WeakMap<
  RuntimeMobileSessionTabsResult,
  {
    authority: RetainedTerminalSnapshotAuthority
    rows: ReadonlyMap<string, RuntimeMobileSessionTerminalClientTab | null>
  }
>()

export function acceptRetainedTerminalSnapshotAuthority(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  runtimeId: string | undefined,
  receivedFrame: number | undefined,
  source: RuntimeMobileSessionTabsResult
): void {
  if (
    !runtimeId ||
    receivedFrame === undefined ||
    source.worktree !== snapshot.worktree ||
    !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, snapshot, receivedFrame, runtimeId)
  ) {
    return
  }
  const rows = new Map<string, RuntimeMobileSessionTerminalClientTab | null>()
  if (
    hostSnapshotAffirmsWorktreeContents(source) &&
    source.publicationEpoch === snapshot.publicationEpoch &&
    source.snapshotVersion === snapshot.snapshotVersion
  ) {
    for (const row of source.tabs) {
      if (row.type === 'terminal') {
        const key = `${row.parentTabId}:${row.leafId}`
        rows.set(key, rows.has(key) ? null : row)
      }
    }
  }
  acceptedSnapshots.set(snapshot, {
    authority: {
      environmentId,
      runtimeId,
      worktreeId: snapshot.worktree,
      receivedFrame,
      retainsStarts: peekRuntimeEnvironmentCapability(
        environmentId,
        TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY,
        runtimeId
      ),
      pairingRevision: getRuntimeEnvironmentRevision(environmentId)
    },
    rows
  })
}

export function retainedTerminalSnapshotPublisher(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): RetainedTerminalSnapshotAuthority | undefined {
  const authority = acceptedSnapshots.get(snapshot)?.authority
  return authority?.environmentId === environmentId &&
    authority.pairingRevision === getRuntimeEnvironmentRevision(environmentId) &&
    isCurrentSessionTabsRuntimeId(environmentId, authority.runtimeId)
    ? authority
    : undefined
}

export function retainedTerminalSnapshotAuthority(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  address: { worktreeId: string; tabId: string; leafId: string }
):
  | { row: RuntimeMobileSessionTerminalClientTab; authority: RetainedTerminalSnapshotAuthority }
  | undefined {
  const authority = retainedTerminalSnapshotPublisher(snapshot, environmentId)
  const row = acceptedSnapshots.get(snapshot)?.rows.get(`${address.tabId}:${address.leafId}`)
  return authority?.worktreeId === address.worktreeId && row ? { row, authority } : undefined
}

export function retiresRetainedTerminalStart(
  previous: TerminalPaneStart | undefined,
  authority: RetainedTerminalSnapshotAuthority | undefined
): boolean {
  const start = previous?.retainedTerminalStart
  if (!start || !authority || start.worktreeId !== authority.worktreeId) {
    return false
  }
  const receipt = previous.retainedHostReceipt
  if (
    receipt &&
    (receipt.environmentId !== authority.environmentId ||
      (receipt.pairingRevision !== authority.pairingRevision &&
        (receipt.pairingRevision === undefined ||
          resolveContinuedRuntimeEnvironmentRevision(
            authority.environmentId,
            receipt.pairingRevision
          ) !== authority.pairingRevision)))
  ) {
    return false
  }
  return (
    (start.runtimeId !== authority.runtimeId &&
      (receipt !== undefined ||
        isRetiredSessionTabsRuntimeId(authority.environmentId, start.runtimeId))) ||
    (authority.retainsStarts === true &&
      receipt !== undefined &&
      authority.receivedFrame > receipt.receivedFrame)
  )
}
