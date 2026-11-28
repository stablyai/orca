// orcad stopped idle, not crashed: a desktop leaves it down until the user needs it (#46567).

/** Sent after admission is fenced with no counted request in flight: nothing unanswered ran. */
export const ORCAD_IDLE_STOP_CLOSE_CODE = 4410
export const ORCAD_IDLE_STOP_CLOSE_REASON = 'orcad stopped idle'

/** A request refused, undispatched, because its host stopped idle (or is stopping). */
export const RUNTIME_IDLE_STOPPED_ERROR_CODE = 'runtime_idle_stopped'
export const RUNTIME_IDLE_STOPPED_MESSAGE =
  'This host stopped while idle. Open its workspace or start a terminal to start it again.'
