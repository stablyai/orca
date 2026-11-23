/** How an orcad tells its clients it stopped idle, not crashed: a desktop then leaves it down
 *  until the user needs it, instead of reconnecting or relaunching it. */

/** Every socket is closed with this once admission is fenced and no counted request is in flight,
 *  so a request still unanswered then was never dispatched and may be sent again after a wake. */
export const ORCAD_IDLE_STOP_CLOSE_CODE = 4410
export const ORCAD_IDLE_STOP_CLOSE_REASON = 'orcad stopped idle'

/** A request refused, undispatched, because its host stopped idle (or is stopping). */
export const RUNTIME_IDLE_STOPPED_ERROR_CODE = 'runtime_idle_stopped'
export const RUNTIME_IDLE_STOPPED_MESSAGE =
  'This host stopped while idle. Open its workspace or start a terminal to start it again.'
