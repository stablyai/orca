import type { PreflightRuntimeContext } from '../../../../preload/api-types'
import type { PreflightDetectAgents } from '../../../../shared/rpc-contract/preflight-params'
import type { z } from 'zod'

type PreflightDetectAgentsParams = z.infer<typeof PreflightDetectAgents>

// Why: the wire schema carries only a named distro or the default flag and rejects null/empty,
// so the raw preload context cannot be forwarded as-is. Precedence mirrors the host's
// `getPreflightWslTarget`: a resolved project runtime wins, then the explicit distro, then the flag.
export function toPreflightDetectAgentsParams(
  context?: PreflightRuntimeContext
): PreflightDetectAgentsParams | undefined {
  const projectRuntime = context?.projectRuntime
  if (projectRuntime) {
    // A repair-required or non-WSL runtime means host-local, same as the desktop twin.
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
