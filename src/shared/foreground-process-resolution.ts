import { recognizeAgentProcess } from './agent-process-recognition'
import { isShellProcess } from './shell-process-detection'
import type { TuiAgent } from './types'

/**
 * Structured identity of a pane's foreground process, carried from the scan to
 * the renderer so an unrecognized live process is no longer collapsed to "bare
 * shell". `engine` is the recognized coding-harness agent (null when the process
 * is not a known agent); `rawProcessName` is the process-table basename (null
 * when inspection was unavailable); `isShell` is true when that name is a known
 * shell binary.
 */
export type ForegroundProcessResolution = {
  engine: TuiAgent | null
  rawProcessName: string | null
  isShell: boolean
}

/**
 * Degrade a raw foreground-process string into the structured resolution. The
 * deployed-relay wire contract stays `string | null` (parent-branch decision),
 * so every consumer that only has the legacy string rebuilds the structure here
 * instead of trusting an old relay to send it.
 */
export function resolveForegroundProcess(processName: string | null): ForegroundProcessResolution {
  return {
    engine: recognizeAgentProcess(processName)?.agent ?? null,
    rawProcessName: processName,
    isShell: processName !== null && isShellProcess(processName)
  }
}
