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

let detectedExecutables: DetectedAgentExecutables = {}

export function setDetectedTuiAgentExecutables(next: DetectedAgentExecutables): void {
  detectedExecutables = { ...next }
}

export function getDetectedTuiAgentExecutable(agent: TuiAgent): string | undefined {
  return detectedExecutables[agent]
}

/** @internal - tests need a clean registry between cases. */
export function _resetDetectedTuiAgentExecutables(): void {
  detectedExecutables = {}
}
