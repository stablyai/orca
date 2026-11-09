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

  it('ignores a cancel once an engine error dropped the session, so no start races its teardown', () => {
    const abandoned = run('start', 'engine-ready', 'abandon')
    expect(transitionDictationSession(abandoned, { type: 'cancel' })).toBe(abandoned)
    expect(run('start', 'engine-ready', 'cancel')).toMatchObject({ phase: 'idle', sessionId: null })
  })

  it('retries a failed recording as a new finishing session, and lets a new dictation replace it', () => {
    const failed = run('start', 'engine-ready', 'abandon', 'fail')
    const retried = transitionDictationSession(failed, { type: 'retry' })
    expect(retried).toMatchObject({ phase: 'stopping' })
    expect(retried.sessionId).not.toBeNull()
    expect(transitionDictationSession(failed, { type: 'start' }).phase).toBe('starting')
    expect(run('start', 'retry').phase).toBe('starting')
  })
})
