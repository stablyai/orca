import type { PreflightRuntimeContext } from '../../../../preload/api-types'
import type { PreflightDetectAgents } from '../../../../shared/rpc-contract/preflight-params'
import type { z } from 'zod'

type PreflightDetectAgentsParams = z.infer<typeof PreflightDetectAgents>

// Why: a repair-required runtime has no valid target, and the wire schema cannot carry that state.
// The desktop twin throws rather than probing, so the caller must skip the request instead of
// falling back to the host, which would list Windows agents a WSL-pinned project cannot launch.
export function isPreflightRepairRequired(context?: PreflightRuntimeContext): boolean {
  return context?.projectRuntime?.status === 'repair-required'
}

// Why: the wire schema carries only a named distro or the default flag and rejects null/empty,
// so the raw preload context cannot be forwarded as-is. Precedence mirrors the host's
// `getPreflightWslTarget`: a resolved project runtime wins, then the explicit distro, then the flag.
export function toPreflightDetectAgentsParams(
  context?: PreflightRuntimeContext
): PreflightDetectAgentsParams | undefined {
  const projectRuntime = context?.projectRuntime
  if (projectRuntime) {
    // A resolved non-WSL runtime is host-local; repair-required never reaches the wire.
    return projectRuntime.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
      ? { wslDistro: projectRuntime.runtime.distro }
      : undefined
  }
  const wslDistro = context?.wslDistro?.trim()
  if (wslDistro) {
    return { wslDistro }
  }
  return context?.wslDefault ? { wslDefault: true } : undefined
}
