import {
  combinePtyProcessInspectionVerdict,
  readPtyProcessInspectionEvidence,
  type PtyProcessVerdict
} from '../../../../shared/pty-process-inspection-evidence'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-process-inspection'

/** Resolve the composite PTY answer used by every destructive terminal close path. */
export function resolveTerminalProcessCloseVerdict(
  result: RuntimeTerminalProcessInspection
): PtyProcessVerdict {
  if (result.unavailable === true) {
    return 'unverifiable'
  }
  return combinePtyProcessInspectionVerdict(readPtyProcessInspectionEvidence(result))
}
