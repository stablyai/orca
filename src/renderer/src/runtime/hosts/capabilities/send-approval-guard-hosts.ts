import type { AppState } from '@/store/types'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { TERMINAL_SEND_APPROVAL_GUARD_RUNTIME_CAPABILITY } from '../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'

let cached: {
  statuses: AppState['runtimeStatusByEnvironmentId'] | null
  key: string
  ids: ReadonlySet<string>
} = { statuses: null, key: '', ids: new Set() }

/** Paired hosts whose send guard refuses mid-turn agents that hide approvals; stable identity while that set is unchanged. */
export function selectSendApprovalGuardEnvironmentIds(
  runtimeStatusByEnvironmentId: AppState['runtimeStatusByEnvironmentId']
): ReadonlySet<string> {
  if (runtimeStatusByEnvironmentId === cached.statuses) {
    return cached.ids
  }
  const ids: string[] = []
  for (const [environmentId, entry] of runtimeStatusByEnvironmentId) {
    if (
      lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(
        TERMINAL_SEND_APPROVAL_GUARD_RUNTIME_CAPABILITY
      )
    ) {
      ids.push(environmentId)
    }
  }
  const key = ids.sort().join('\n')
  cached = {
    statuses: runtimeStatusByEnvironmentId,
    key,
    ids: key === cached.key ? cached.ids : new Set(ids)
  }
  return cached.ids
}

/** Local and WSL-relay PTYs run this build; a paired PTY's host must advertise the guard. */
export function ptyHostGuardsSendApprovals(
  guardEnvironmentIds: ReadonlySet<string>,
  ptyId: string
): boolean {
  if (!isRemoteRuntimePtyId(ptyId)) {
    return true
  }
  const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
  return environmentId != null && guardEnvironmentIds.has(environmentId)
}
