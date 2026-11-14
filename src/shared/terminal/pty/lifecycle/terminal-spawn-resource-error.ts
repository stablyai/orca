import {
  LEGACY_PTY_ALLOCATION_HINT,
  LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
  PTY_ALLOCATION_HINT,
  TERMINAL_HOST_CAP_HINT,
  TERMINAL_PROCESS_LIMIT_HINT
} from './terminal-spawn-error-copy'

export function isTerminalResourceLimitError(error: string): boolean {
  return [
    PTY_ALLOCATION_HINT,
    LEGACY_PTY_ALLOCATION_HINT,
    TERMINAL_PROCESS_LIMIT_HINT,
    LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
    TERMINAL_HOST_CAP_HINT
  ].some((hint) => error.includes(hint))
}
