import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'

import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

// Why: both remote shapes are answered across a link — paired runtimes
// ("remote:", host-owned buffer) and direct SSH ("ssh:<target>@@<id>", main's
// relay-fed model, whose serialize can block on host RPCs). Silence from either
// is `unverifiable`, never proof of death (docs/reference/ssh-execution-boundary.md).
export function isRemoteExecutionHostPtyId(ptyId: string | null | undefined): boolean {
  if (typeof ptyId !== 'string') {
    return false
  }
  return isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId) !== null
}
