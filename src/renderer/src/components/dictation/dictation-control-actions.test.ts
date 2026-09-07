import { describe, expect, it, vi } from 'vitest'
import { applyDictationControlAction, canStopDictationSession } from './dictation-control-actions'

function handlers() {
  return {
    startDictation: vi.fn(),
    stopDictation: vi.fn(),
    pauseDictation: vi.fn(),
    resumeDictation: vi.fn(),
    clearUtterance: vi.fn()
  }
}

describe('applyDictationControlAction', () => {
  it('saves from listening or paused and ignores save while idle', () => {
    const listening = handlers()
    applyDictationControlAction('stop', 'listening', listening)
    expect(listening.stopDictation).toHaveBeenCalledOnce()

    const paused = handlers()
    applyDictationControlAction('stop', 'paused', paused)
    expect(paused.stopDictation).toHaveBeenCalledOnce()

    const idle = handlers()
    applyDictationControlAction('stop', 'idle', idle)
    expect(idle.stopDictation).not.toHaveBeenCalled()
  })

  it('pauses, resumes, and clears without starting or stopping', () => {
    const paused = handlers()
    applyDictationControlAction('pause', 'listening', paused)
    applyDictationControlAction('resume', 'paused', paused)
    applyDictationControlAction('clear', 'listening', paused)

    expect(paused.pauseDictation).toHaveBeenCalledOnce()
    expect(paused.resumeDictation).toHaveBeenCalledOnce()
    expect(paused.clearUtterance).toHaveBeenCalledOnce()
    expect(paused.startDictation).not.toHaveBeenCalled()
    expect(paused.stopDictation).not.toHaveBeenCalled()
  })

  it('keeps toggle-to-stop while listening so Save and the shortcut still end the session', () => {
    const listening = handlers()
    applyDictationControlAction('toggle', 'listening', listening)
    expect(listening.stopDictation).toHaveBeenCalledOnce()
    expect(listening.startDictation).not.toHaveBeenCalled()
    expect(listening.pauseDictation).not.toHaveBeenCalled()
    expect(listening.clearUtterance).not.toHaveBeenCalled()
  })
})

describe('canStopDictationSession', () => {
  it('treats paused as an open session that can still save', () => {
    expect(canStopDictationSession('paused')).toBe(true)
    expect(canStopDictationSession('idle')).toBe(false)
  })
})
