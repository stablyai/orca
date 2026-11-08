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
    const started = run('start')
    const stopped = run('start', 'stop', 'engine-ready')
    expect(stopped).toMatchObject({ phase: 'stopping', sessionId: started.sessionId })
  })

  it('drops the session on an engine error and refuses a new start until teardown ends', () => {
    const listening = run('start', 'engine-ready')
    const abandoned = transitionDictationSession(listening, { type: 'abandon' })
    expect(abandoned).toMatchObject({ phase: 'stopping', sessionId: null })
    expect(abandoned.run).not.toBe(listening.run)
    expect(transitionDictationSession(abandoned, { type: 'start' })).toBe(abandoned)

    const restarted = run('start', 'engine-ready', 'abandon', 'ended', 'start')
    expect(restarted.phase).toBe('starting')
    expect(restarted.sessionId).not.toBe(listening.sessionId)
  })
})
