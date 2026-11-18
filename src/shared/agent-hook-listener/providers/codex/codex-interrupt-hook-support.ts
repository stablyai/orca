import type { CodexRolloutState } from './codex-rollout-state'

// Codex 0.150 added the Interrupt hook; older Codex records a cancel only as rollout turn_aborted.
const FIRST_INTERRUPT_HOOK_VERSION = [0, 150] as const

function predatesInterruptHook(cliVersion: string): boolean | undefined {
  const match = /^(\d+)\.(\d+)\./.exec(cliVersion)
  if (!match) {
    return undefined
  }
  const [major, minor] = [Number(match[1]), Number(match[2])]
  const [firstMajor, firstMinor] = FIRST_INTERRUPT_HOOK_VERSION
  return major < firstMajor || (major === firstMajor && minor < firstMinor)
}

/** Whether a cancel must come from the rollout: decided by this pane's own Codex version from its
 *  session_meta; an unknown version keeps the rollout check, which is harmless on newer Codex. */
export function codexCancelNeedsRollout(rollout: CodexRolloutState | undefined): boolean {
  return rollout?.cliVersion ? (predatesInterruptHook(rollout.cliVersion) ?? true) : true
}
