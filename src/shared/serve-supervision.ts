import {
  QUIT_RENDERER_ACK_TIMEOUT_MS,
  WILL_QUIT_TEARDOWN_DEADLINE_MS
} from './quit-teardown-deadline'

export const SERVE_TEMP_DIRECTORY_ENV = 'ORCA_SERVE_TMPDIR'
export const SERVE_SUPERVISOR_ENV = 'ORCA_SERVE_SUPERVISED'
export const SERVE_ALREADY_RUNNING_EXIT_CODE = 3
export const SERVE_SUPERVISOR_STOP_EXIT_CODE = 4
export const SERVE_CHILD_FORCE_KILL_SCHEDULING_MARGIN_MS = 5_000
export const SERVE_SUPERVISED_SHUTDOWN_GRACE_MS =
  QUIT_RENDERER_ACK_TIMEOUT_MS +
  WILL_QUIT_TEARDOWN_DEADLINE_MS +
  SERVE_CHILD_FORCE_KILL_SCHEDULING_MARGIN_MS

export type ServeSupervisorHealth = {
  websocket: 'ready' | 'unavailable'
  runtime: 'ready' | 'unavailable'
  graph: 'ready' | 'reloading' | 'unavailable'
}
