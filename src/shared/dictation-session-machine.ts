import type { DictationState } from './speech-types'

/** One dictation session's lifecycle, shared so every client follows the same start/stop/cancel rules. */
export type DictationSession = {
  phase: DictationState
  /** Bumps on every start and every drop, so async work from an older run can tell it lost. */
  run: number
  /** Speech events are accepted only for this id. */
  sessionId: string | null
  heardFinalText: boolean
}

export type DictationSessionEvent =
  | { type: 'start' }
  /** Keeps the session: a stop while starting finishes (and inserts the words) once the engine is up. */
  | { type: 'stop' }
  | { type: 'engine-ready' }
  | { type: 'final-text' }
  /** The engine failed mid-session: drop the session while capture and the engine tear down. */
  | { type: 'abandon' }
  /** Starting failed: drop the session and show the error. */
  | { type: 'fail' }
  /** Drop the session without finishing it. */
  | { type: 'cancel' }
  /** Teardown finished; back to idle. */
  | { type: 'ended' }

export const initialDictationSession: DictationSession = {
  phase: 'idle',
  run: 0,
  sessionId: null,
  heardFinalText: false
}

export function canStartDictation(phase: DictationState): boolean {
  return phase === 'idle'
}

export function isDictationUnderway(phase: DictationState): boolean {
  return phase === 'starting' || phase === 'listening'
}

/** Returns the same object when the event does not apply, so callers can skip its effects. */
export function transitionDictationSession(
  session: DictationSession,
  event: DictationSessionEvent
): DictationSession {
  switch (event.type) {
    case 'start': {
      if (!canStartDictation(session.phase)) {
        return session
      }
      const run = session.run + 1
      return { phase: 'starting', run, sessionId: String(run), heardFinalText: false }
    }
    case 'stop':
      return isDictationUnderway(session.phase) ? { ...session, phase: 'stopping' } : session
    case 'engine-ready':
      return session.phase === 'starting' ? { ...session, phase: 'listening' } : session
    case 'final-text':
      return session.heardFinalText ? session : { ...session, heardFinalText: true }
    case 'abandon':
      return dropSession(session, 'stopping')
    case 'fail':
      return dropSession(session, 'error')
    case 'cancel':
    case 'ended':
      return dropSession(session, 'idle')
  }
}

function dropSession(session: DictationSession, phase: DictationState): DictationSession {
  return { phase, run: session.run + 1, sessionId: null, heardFinalText: false }
}
