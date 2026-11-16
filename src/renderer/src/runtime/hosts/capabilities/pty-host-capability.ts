import type { AppState } from '@/store/types'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'

/** Local/WSL relay PTYs run this build; a paired host must advertise it; unbound PTYs prove nothing. */
export function ptyHostAdvertisesCapability(
  runtimeStatusByEnvironmentId: AppState['runtimeStatusByEnvironmentId'],
  ptyId: string | null | undefined,
  capability: RuntimeCapability
): boolean {
  if (!ptyId) {
    return false
  }
  if (!isRemoteRuntimePtyId(ptyId)) {
    return true
  }
  const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
  const entry = environmentId ? runtimeStatusByEnvironmentId.get(environmentId) : undefined
  return lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(capability) === true
}
