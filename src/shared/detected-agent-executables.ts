import type { TuiAgent } from './types'

/**
 * Which executable name actually matched on PATH for each detected agent.
 *
 * Why: `detectCmdAliases` lets one agent be installed under more than one
 * binary name (`cursor-agent` vs Cursor.app's `cursor`), but launch commands
 * are static config. Detection is the only place that knows which name is
 * really there, so it publishes the answer here for the launch path to read.
 *
 * Process-local by design: the renderer and the main process each detect and
 * populate their own copy, and neither is valid for a remote host.
 */
export type DetectedAgentExecutables = Partial<Record<TuiAgent, string>>

/**
 * Where a planned command will actually run, relative to the process that
 * detected these executables.
 *
 * Why: the registry describes one host's PATH. An SSH host or a WSL distro has
 * its own install layout, so a plan bound for either must fall back to the
 * static defaults instead of inheriting this host's alias.
 */
export type AgentExecutionRuntime = {
  isRemote?: boolean
  /** Platform the command will run on (`'linux'` for a WSL distro). */
  platform?: NodeJS.Platform
}

let detectedExecutables: DetectedAgentExecutables = {}
let detectedPlatform: NodeJS.Platform | undefined

/**
 * Publish the executables matched by a detection pass. `platform` is the
 * runtime they were detected on — omit it only in tests that do not exercise
 * cross-runtime isolation.
 */
export function setDetectedTuiAgentExecutables(
  next: DetectedAgentExecutables,
  platform?: NodeJS.Platform
): void {
  detectedExecutables = { ...next }
  detectedPlatform = platform
}

export function getDetectedTuiAgentExecutable(
  agent: TuiAgent,
  runtime?: AgentExecutionRuntime
): string | undefined {
  if (runtime?.isRemote) {
    return undefined
  }
  // Why: a WSL launch is local (never `isRemote`) but runs against the distro's
  // PATH, so a Windows-detected `cursor` must not become `cursor agent` there.
  if (
    runtime?.platform !== undefined &&
    detectedPlatform !== undefined &&
    runtime.platform !== detectedPlatform
  ) {
    return undefined
  }
  return detectedExecutables[agent]
}

/** @internal - tests need a clean registry between cases. */
export function _resetDetectedTuiAgentExecutables(): void {
  detectedExecutables = {}
  detectedPlatform = undefined
}
