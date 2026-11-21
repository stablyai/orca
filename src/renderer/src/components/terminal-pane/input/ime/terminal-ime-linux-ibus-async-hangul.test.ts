// @vitest-environment happy-dom
// Async IBus Hangul clears the preedit, ends the composition empty, then commits the syllable as a bare insertText (#42246).
import { describe, expect, it } from 'vitest'
import {
  nextEventLoop,
  openLinuxPaneReplaySession,
  useLinuxPaneTestEnvironment,
  type LinuxPaneReplaySession
} from './terminal-ime-linux-pane-replay-fixture'

function composeSyllable(session: LinuxPaneReplaySession, code: string, syllable: string): void {
  session.emit({ type: 'keydown', key: 'Process', code, keyCode: 229 })
  session.emit({ type: 'compositionstart' })
  session.emit({ type: 'compositionupdate', data: syllable })
  session.emit({
    type: 'input',
    inputType: 'insertCompositionText',
    data: syllable,
    value: syllable
  })
}

describe('Linux async IBus Hangul commits', () => {
  useLinuxPaneTestEnvironment()

  it('sends a syllable committed after the finalizer, ahead of the key that ended it', async () => {
    const session = await openLinuxPaneReplaySession('\x1b[>11u')
    composeSyllable(session, 'KeyR', '역')
    // Chromium dispatches the held Shift+9 as Process while IBus clears the preedit.
    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'Digit9',
      keyCode: 229,
      shiftKey: true,
      isComposing: true
    })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    session.emit({ type: 'compositionend', data: '' })
    await nextEventLoop()
    session.emit({ type: 'input', inputType: 'insertText', data: '역', value: '역' })
    // IBus then forwards the unconsumed '(' itself.
    session.emit({ type: 'keydown', key: '(', code: 'Digit9', keyCode: 57, shiftKey: true })
    session.emit({ type: 'keypress', key: '(', code: 'Digit9', charCode: 40, shiftKey: true })
    session.emit({ type: 'input', inputType: 'insertText', data: '(', value: '역(' })
    session.emit({ type: 'keyup', key: '(', code: 'Digit9', keyCode: 57, shiftKey: true })
    await nextEventLoop()

    expect(session.emitted()).toBe('역\x1b[57;2u\x1b[57;2:3u')
  })

  it('sends a syllable committed after xterm cancelled the emptied preedit', async () => {
    const session = await openLinuxPaneReplaySession()
    composeSyllable(session, 'KeyQ', '없')
    session.emit({ type: 'keydown', key: 'Process', code: 'KeyS', keyCode: 229, isComposing: true })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    // A macrotask before compositionend lets xterm's preedit resync cancel the session.
    await nextEventLoop()
    session.emit({ type: 'compositionend', data: '' })
    await nextEventLoop()
    session.emit({ type: 'input', inputType: 'insertText', data: '없', value: '없' })
    await nextEventLoop()

    expect(session.emitted()).toBe('없')
  })

  it('sends a syllable flushed by Esc ahead of the forwarded Esc', async () => {
    const session = await openLinuxPaneReplaySession()
    composeSyllable(session, 'KeyR', '역')
    // ibus-hangul's default off-key flushes the syllable on Esc and forwards the key.
    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'Escape',
      keyCode: 229,
      isComposing: true
    })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    session.emit({ type: 'compositionend', data: '' })
    await nextEventLoop()
    session.emit({ type: 'input', inputType: 'insertText', data: '역', value: '역' })
    session.emit({ type: 'keydown', key: 'Escape', code: 'Escape', keyCode: 27 })
    await nextEventLoop()

    expect(session.emitted()).toBe('역\x1b')
  })

  it('does not claim a bare insertText after Backspace emptied the preedit', async () => {
    const session = await openLinuxPaneReplaySession()
    composeSyllable(session, 'KeyR', 'ㄱ')
    // ibus-hangul never flushes on BackSpace; deleting the last jamo leaves nothing owed.
    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'Backspace',
      keyCode: 229,
      isComposing: true
    })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    session.emit({ type: 'compositionend', data: '' })
    await nextEventLoop()
    session.emit({ type: 'input', inputType: 'insertText', data: 'ㄱ', value: 'ㄱ' })
    await nextEventLoop()

    expect(session.emitted()).toBe('')
  })

  it('leaves a commit to xterm while its compositionend is still deferred', async () => {
    const session = await openLinuxPaneReplaySession()
    session.emit({ type: 'keydown', key: 'Process', code: 'KeyR', keyCode: 229 })
    session.emit({ type: 'compositionstart' })
    session.emit({ type: 'compositionupdate', data: '역' })
    // No textarea progress yet, so xterm defers this end to its next macrotask.
    session.emit({ type: 'compositionend', data: '' })
    session.emit({ type: 'input', inputType: 'insertText', data: '역', value: '역' })
    await nextEventLoop()

    expect(session.emitted()).toBe('역')
  })
})
