import {
  evaluateRuntimeStatusCompat,
  type RuntimeStatusCompatInput
} from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/**
 * Version skew between this desktop and the orcad inside an Orca Cloud sandbox. The golden image
 * follows cloud/integration HEAD and desktops update on their own schedule, so builds rarely match.
 * The rule is the runtime protocol range (shared/protocol-version.ts), never commits or app
 * versions: inside the range the workspace just works and nothing is shown.
 * - `sandbox-older`: the sandbox's orcad speaks a protocol below what this desktop still supports.
 * - `desktop-older`: the sandbox's orcad requires a newer protocol than this desktop speaks.
 */
export type CloudRuntimeSkew =
  | { kind: 'compatible' }
  | {
      kind: 'sandbox-older' | 'desktop-older'
      desktopProtocolVersion: number
      sandboxProtocolVersion: number
      sandboxAppVersion: string | null
      sandboxBuildCommit: string | null
    }

type CloudRuntimeSkewInput = RuntimeStatusCompatInput &
  Pick<RuntimeStatus, 'appVersion' | 'buildCommit'>

export function evaluateCloudRuntimeSkew(
  status: CloudRuntimeSkewInput,
  desktop?: { protocolVersion: number; minCompatibleServerProtocolVersion: number }
): CloudRuntimeSkew {
  // Same verdict as the RPC gate, so the notice shows exactly when the gate refuses this sandbox.
  const verdict = evaluateRuntimeStatusCompat(status, desktop)
  if (verdict.kind === 'ok') {
    return { kind: 'compatible' }
  }
  return {
    kind: verdict.reason === 'client-too-old' ? 'desktop-older' : 'sandbox-older',
    desktopProtocolVersion: verdict.clientProtocolVersion,
    sandboxProtocolVersion: verdict.serverProtocolVersion,
    sandboxAppVersion: status.appVersion ?? null,
    sandboxBuildCommit: status.buildCommit ?? null
  }
}
