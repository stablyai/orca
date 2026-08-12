export const SERVE_TEMP_DIRECTORY_ENV = 'ORCA_SERVE_TMPDIR'
export const SERVE_SUPERVISOR_ENV = 'ORCA_SERVE_SUPERVISED'
export const SERVE_ALREADY_RUNNING_EXIT_CODE = 3
export const SERVE_SUPERVISOR_STOP_EXIT_CODE = 4

export type ServeSupervisorHealth = {
  websocket: 'ready' | 'unavailable'
  runtime: 'ready' | 'unavailable'
  graph: 'ready' | 'reloading' | 'unavailable'
}
