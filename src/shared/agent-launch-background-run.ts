/**
 * How a desktop automation's `backgroundRun` launch can fail before its run has an agent.
 *
 * Unavailable: the host refused before any spawn was requested, so the window starts the run itself,
 * as on main. Spawn failed: the window's own spawn failed on the host, so the run fails as main's did.
 */
export const AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE =
  'agent_launch_background_run_unavailable'
export const AGENT_LAUNCH_BACKGROUND_RUN_SPAWN_FAILED_CODE =
  'agent_launch_background_run_spawn_failed'
