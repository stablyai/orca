import { describe, expect, it } from 'vitest'
import {
  initialDictationSession,
  transitionDictationSession,
  type DictationSession,
  type DictationSessionEvent
} from './dictation-session-machine'

function run(...events: DictationSessionEvent['type'][]): DictationSession {
  return events.reduce(
    (session, type) => transitionDictationSession(session, { type }),
    initialDictationSession
  )
}

describe('transitionDictationSession', () => {
  it('keeps the session when stop arrives while starting, and finishes instead of listening', () => {
    expect(run('start', 'stop', 'engine-ready')).toEqual({
      phase: 'stopping',
      run: 1,
      sessionId: '1',
      stopRequested: true,
      heardFinalText: false
    })
  })

  it('drops the session on an engine error and refuses a new start until teardown ends', () => {
    const abandoned = run('start', 'engine-ready', 'abandon')
    expect(abandoned).toMatchObject({ phase: 'stopping', run: 2, sessionId: null })
    expect(transitionDictationSession(abandoned, { type: 'start' })).toBe(abandoned)
    expect(run('start', 'engine-ready', 'abandon', 'ended', 'start')).toMatchObject({
      phase: 'starting',
      sessionId: '4'
    })
  })

  it('ignores stop once the session is already stopping', () => {
    const stopping = run('start', 'engine-ready', 'stop')
    expect(transitionDictationSession(stopping, { type: 'stop' })).toBe(stopping)
  })
})
