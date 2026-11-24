import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { TERMINAL_SEND_APPROVAL_GUARD_RUNTIME_CAPABILITY } from '../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'

let cached: {
  statuses: RuntimeStatuses | null
  key: string
  ids: ReadonlySet<string>
} = { statuses: null, key: '', ids: new Set() }

/** Paired hosts whose send guard refuses mid-turn agents that hide approvals; stable identity while that set is unchanged. */
export function selectSendApprovalGuardEnvironmentIds(
  statuses: RuntimeStatuses
): ReadonlySet<string> {
  if (statuses === cached.statuses) {
    return cached.ids
  }
  const ids: string[] = []
  for (const [environmentId, entry] of statuses) {
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
    statuses,
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
