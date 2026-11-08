import { STRUCTURED_WORKER_HANDLE_PREFIX } from './orchestration/workers/structured-worker-handle'

// Dependency-light leaf so CLI startup avoids the session-address codec's zod graph.
const TERMINAL_HANDLE_PREFIXES = ['term_', STRUCTURED_WORKER_HANDLE_PREFIX] as const

export function isTerminalHandle(token: string): boolean {
  return TERMINAL_HANDLE_PREFIXES.some((prefix) => token.startsWith(prefix))
}
