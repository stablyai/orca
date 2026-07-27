import { CLIENT_PLATFORM } from '@/lib/client-platform'
import { setDetectedTuiAgentExecutables } from '../../../../shared/detected-agent-executables'
import type { PreflightRuntimeContext } from '../../../../preload/api-types'

let latestPublication = 0

/**
 * Publishes the executables matched by the host's agent detection.
 *
 * Why: launch commands are built synchronously all over the renderer, so the
 * matched executable per agent lives in a module registry instead of being
 * threaded through every buildAgentStartupPlan() call site. Callers await this
 * before exposing detection results so a launch never races the alias.
 */
export async function publishDetectedAgentExecutables(
  context: PreflightRuntimeContext | undefined,
  isCurrent: () => boolean
): Promise<void> {
  latestPublication += 1
  const publication = latestPublication
  try {
    const executables = await window.api.preflight.detectAgentExecutables?.(context)
    // Why: null means a WSL/web detection, which says nothing about this host's
    // PATH — keep the host snapshot. A newer request supersedes this one.
    if (executables == null || publication !== latestPublication || !isCurrent()) {
      return
    }
    // Why: stamping the client platform lets the launch path drop the registry
    // for commands bound for another runtime.
    setDetectedTuiAgentExecutables(executables, CLIENT_PLATFORM)
  } catch {
    // Why: alias resolution is optional; static launch commands remain valid.
  }
}
