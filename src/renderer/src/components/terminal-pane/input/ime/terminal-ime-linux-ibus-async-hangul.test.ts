// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  openLinuxPaneReplaySession,
  replayThroughLinuxPane,
  useLinuxPaneTestEnvironment
} from './terminal-ime-linux-pane-replay-fixture'

const KITTY_FLAGS_11 = '\x1b[>11u'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

describe('Linux async IBus Hangul commit preservation', () => {
  useLinuxPaneTestEnvironment()

  it('preserves Hangul syllables when IBus async D-Bus CommitText lands after finalizerTimer', async () => {
    const session = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    // Compose '문'
    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyA',
      keyCode: 229,
      isComposing: false
    })
    session.emit({ type: 'compositionstart', data: '' })
    session.emit({ type: 'compositionupdate', data: 'ㅁ' })
    session.emit({
      type: 'input',
      inputType: 'insertCompositionText',
      data: 'ㅁ',
      value: 'ㅁ'
    })
    session.emit({ type: 'keyup', key: 'a', code: 'KeyA', keyCode: 65, isComposing: false })

    session.emit({ type: 'keydown', key: 'Process', code: 'KeyN', keyCode: 229, isComposing: true })
    session.emit({ type: 'compositionupdate', data: '무' })
    session.emit({
      type: 'input',
      inputType: 'insertCompositionText',
      data: '무',
      value: '무'
    })
    session.emit({ type: 'keyup', key: 'n', code: 'KeyN', keyCode: 78, isComposing: true })

    session.emit({ type: 'keydown', key: 'Process', code: 'KeyS', keyCode: 229, isComposing: true })
    session.emit({ type: 'compositionupdate', data: '문' })
    session.emit({
      type: 'input',
      inputType: 'insertCompositionText',
      data: '문',
      value: '문'
    })
    session.emit({ type: 'keyup', key: 's', code: 'KeyS', keyCode: 83, isComposing: true })

    // Next Hangul key clears preedit and ends composition before CommitText('문') arrives.
    session.emit({ type: 'keydown', key: 'Process', code: 'KeyW', keyCode: 229, isComposing: true })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({
      type: 'input',
      inputType: 'deleteContentBackward',
      value: ''
    })
    session.emit({ type: 'compositionend', data: '' })

    // finalizerTimer runs in this macrotask turn BEFORE async D-Bus CommitText arrives.
    await nextEventLoop()
    expect(session.emitted()).toBe('')

    session.emit({ type: 'input', inputType: 'insertText', data: '문', value: '문' })
    await nextEventLoop()
    expect(session.emitted()).toBe('문')
  })

  it('preserves composing syllable when a macrotask runs between empty compositionupdate and compositionend', async () => {
    const session = await openLinuxPaneReplaySession()

    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyD',
      keyCode: 229,
      isComposing: false
    })
    session.emit({ type: 'compositionstart', data: '' })
    session.emit({ type: 'compositionupdate', data: 'ㅇ' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: 'ㅇ', value: 'ㅇ' })
    session.emit({ type: 'keydown', key: 'Process', code: 'KeyJ', keyCode: 229, isComposing: true })
    session.emit({ type: 'compositionupdate', data: '어' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: '어', value: '어' })
    session.emit({ type: 'keydown', key: 'Process', code: 'KeyQ', keyCode: 229, isComposing: true })
    session.emit({ type: 'compositionupdate', data: '없' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: '없', value: '없' })

    session.emit({ type: 'keydown', key: 'Process', code: 'KeyS', keyCode: 229, isComposing: true })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })

    // Macrotask yield between UpdatePreeditText('') and HidePreeditText.
    await nextEventLoop()

    session.emit({ type: 'compositionend', data: '' })
    await nextEventLoop()
    session.emit({ type: 'input', inputType: 'insertText', data: '없', value: '없' })
    await nextEventLoop()

    expect(session.emitted()).toBe('없')
  })

  it('preserves Kitty encoding and does not replay cancelled Hangul preedit when plain typing follows Backspace clear before finalizer settles', async () => {
    const session = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    session.emit({ type: 'compositionstart', data: '' })
    session.emit({ type: 'compositionupdate', data: 'ㄱ' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: 'ㄱ', value: 'ㄱ' })
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

    // Next plain key lands synchronously before finalizerTimer runs.
    session.emit({ type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65, isComposing: false })
    session.emit({
      type: 'keypress',
      key: 'a',
      code: 'KeyA',
      keyCode: 97,
      charCode: 97,
      isComposing: false
    })
    session.emit({ type: 'input', inputType: 'insertText', data: 'a', value: 'a' })
    session.emit({ type: 'keyup', key: 'a', code: 'KeyA', keyCode: 65, isComposing: false })
    await nextEventLoop()

    expect(session.emitted()).toBe('\x1b[97u\x1b[97;1:3u')
  })

  it('lets GTK/XIM non-composing Hangul commit settle before Kitty-encoded Space', async () => {
    const session = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    session.emit({ type: 'compositionstart', data: '' })
    session.emit({ type: 'compositionupdate', data: 'ㄱ' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: 'ㄱ', value: 'ㄱ' })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    session.emit({ type: 'compositionend', data: '' })

    // Physical Hangul keydown delivered without isComposing while transaction awaits CommitText.
    session.emit({ type: 'keydown', key: 'k', code: 'KeyK', keyCode: 75, isComposing: false })
    session.emit({
      type: 'keypress',
      key: '가',
      code: 'KeyK',
      keyCode: 44032,
      charCode: 44032,
      isComposing: false
    })
    session.emit({ type: 'input', inputType: 'insertText', data: '가', value: '가' })
    session.emit({ type: 'keyup', key: 'k', code: 'KeyK', keyCode: 75, isComposing: false })

    session.emit({ type: 'keydown', key: ' ', code: 'Space', keyCode: 32, isComposing: false })
    session.emit({
      type: 'keypress',
      key: ' ',
      code: 'Space',
      keyCode: 32,
      charCode: 32,
      isComposing: false
    })
    session.emit({ type: 'input', inputType: 'insertText', data: ' ', value: '가 ' })
    session.emit({ type: 'keyup', key: ' ', code: 'Space', keyCode: 32, isComposing: false })
    await nextEventLoop()

    expect(session.emitted()).toBe('가\x1b[32u\x1b[32;1:3u')
  })

  it('preserves Hangul commit order and Kitty encoding when shifted ( lands after finalizer settlement', async () => {
    const { emitted } = await replayThroughLinuxPane(
      [
        { type: 'keydown', key: 'Process', code: 'KeyR', keyCode: 229, isComposing: false },
        { type: 'compositionstart', data: '' },
        { type: 'compositionupdate', data: '역' },
        { type: 'input', inputType: 'insertCompositionText', data: '역', value: '역' },
        { type: 'compositionupdate', data: '' },
        { type: 'input', inputType: 'deleteContentBackward', value: '' },
        { type: 'compositionend', data: '' },
        {
          type: 'keydown',
          key: 'Shift',
          code: 'ShiftLeft',
          keyCode: 16,
          shiftKey: true,
          isComposing: false
        },
        {
          type: 'keydown',
          key: '(',
          code: 'Digit9',
          keyCode: 57,
          shiftKey: true,
          isComposing: false
        },
        { type: 'input', inputType: 'insertText', data: '역', value: '역' },
        {
          type: 'keypress',
          key: '(',
          code: 'Digit9',
          keyCode: 40,
          charCode: 40,
          shiftKey: true,
          isComposing: false
        },
        { type: 'input', inputType: 'insertText', data: '(', value: '역(' },
        {
          type: 'keyup',
          key: '(',
          code: 'Digit9',
          keyCode: 57,
          shiftKey: true,
          isComposing: false
        }
      ],
      KITTY_FLAGS_11
    )

    expect(emitted).toBe('역\x1b[57;2u\x1b[57;2:3u')
  })

  it('preserves Hangul commit order and Kitty encoding when shifted ( and async CommitText land while transaction is pending', async () => {
    const session = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    session.emit({ type: 'compositionstart', data: '' })
    session.emit({ type: 'compositionupdate', data: '역' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: '역', value: '역' })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    session.emit({ type: 'compositionend', data: '' })

    session.emit({
      type: 'keydown',
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      shiftKey: true,
      isComposing: false
    })
    session.emit({
      type: 'keydown',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    session.emit({ type: 'input', inputType: 'insertText', data: '역', value: '역' })
    session.emit({
      type: 'keypress',
      key: '(',
      code: 'Digit9',
      keyCode: 40,
      charCode: 40,
      shiftKey: true,
      isComposing: false
    })
    session.emit({ type: 'input', inputType: 'insertText', data: '(', value: '역(' })
    session.emit({
      type: 'keyup',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    await nextEventLoop()

    expect(session.emitted()).toBe('역\x1b[57;2u\x1b[57;2:3u')
  })

  it('defers claimed shifted ( echo and release until pending Hangul finalizer settles', async () => {
    const session = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    session.emit({ type: 'compositionstart', data: '' })
    session.emit({ type: 'compositionupdate', data: '역' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: '역', value: '역' })
    session.emit({ type: 'compositionend', data: '역' })

    session.emit({
      type: 'keydown',
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      shiftKey: true,
      isComposing: false
    })
    session.emit({
      type: 'keydown',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    session.emit({
      type: 'keypress',
      key: '(',
      code: 'Digit9',
      keyCode: 40,
      charCode: 40,
      shiftKey: true,
      isComposing: false
    })
    session.emit({ type: 'input', inputType: 'insertText', data: '(', value: '역(' })
    session.emit({
      type: 'keyup',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    await nextEventLoop()

    expect(session.emitted()).toBe('역\x1b[57;2u\x1b[57;2:3u')
  })

  it('holds deferred post-composition commits across finalizer settlement while awaiting async CommitText', async () => {
    const session = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    session.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    session.emit({ type: 'compositionstart', data: '' })
    session.emit({ type: 'compositionupdate', data: '역' })
    session.emit({ type: 'input', inputType: 'insertCompositionText', data: '역', value: '역' })
    session.emit({ type: 'compositionupdate', data: '' })
    session.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    session.emit({ type: 'compositionend', data: '' })

    // Shifted '(' completes while composition transaction is still pending, before CommitText('역').
    session.emit({
      type: 'keydown',
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      shiftKey: true,
      isComposing: false
    })
    session.emit({
      type: 'keydown',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    session.emit({
      type: 'keypress',
      key: '(',
      code: 'Digit9',
      keyCode: 40,
      charCode: 40,
      shiftKey: true,
      isComposing: false
    })
    session.emit({ type: 'input', inputType: 'insertText', data: '(', value: '(' })
    session.emit({
      type: 'keyup',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })

    // finalizerTimer settles into awaiting post-composition input; '(' stays held behind CommitText.
    await nextEventLoop()
    expect(session.emitted()).toBe('')

    session.emit({ type: 'input', inputType: 'insertText', data: '역', value: '역' })
    await nextEventLoop()

    expect(session.emitted()).toBe('역\x1b[57;2u\x1b[57;2:3u')
  })

  it('flushes deferred commits on blur without inventing releases for held keys while dispose cancels without flushing', async () => {
    const blurSession = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    blurSession.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    blurSession.emit({ type: 'compositionstart', data: '' })
    blurSession.emit({ type: 'compositionupdate', data: '역' })
    blurSession.emit({ type: 'input', inputType: 'insertCompositionText', data: '역', value: '역' })
    blurSession.emit({ type: 'compositionupdate', data: '' })
    blurSession.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    blurSession.emit({ type: 'compositionend', data: '' })

    blurSession.emit({
      type: 'keydown',
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      shiftKey: true,
      isComposing: false
    })
    blurSession.emit({
      type: 'keydown',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    blurSession.emit({
      type: 'keypress',
      key: '(',
      code: 'Digit9',
      keyCode: 40,
      charCode: 40,
      shiftKey: true,
      isComposing: false
    })
    blurSession.emit({ type: 'input', inputType: 'insertText', data: '(', value: '(' })
    blurSession.emit({ type: 'blur' })
    await nextEventLoop()

    expect(blurSession.emitted()).toBe('\x1b[57;2u')

    const disposeSession = await openLinuxPaneReplaySession(KITTY_FLAGS_11)
    disposeSession.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    disposeSession.emit({ type: 'compositionstart', data: '' })
    disposeSession.emit({ type: 'compositionupdate', data: '역' })
    disposeSession.emit({
      type: 'input',
      inputType: 'insertCompositionText',
      data: '역',
      value: '역'
    })
    disposeSession.emit({ type: 'compositionupdate', data: '' })
    disposeSession.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    disposeSession.emit({ type: 'compositionend', data: '' })

    disposeSession.emit({
      type: 'keydown',
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      shiftKey: true,
      isComposing: false
    })
    disposeSession.emit({
      type: 'keydown',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    disposeSession.emit({
      type: 'keypress',
      key: '(',
      code: 'Digit9',
      keyCode: 40,
      charCode: 40,
      shiftKey: true,
      isComposing: false
    })
    disposeSession.emit({ type: 'input', inputType: 'insertText', data: '(', value: '(' })
    disposeSession.emit({
      type: 'keyup',
      key: '(',
      code: 'Digit9',
      keyCode: 57,
      shiftKey: true,
      isComposing: false
    })
    disposeSession.dispose()
    await nextEventLoop()

    expect(disposeSession.emitted()).toBe('')
  })

  it('forwards unclaimed Process/229 text after Backspace-cancelled Hangul preedit without duplicating or replaying preedit', async () => {
    const unclaimedOnly = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    unclaimedOnly.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    unclaimedOnly.emit({ type: 'compositionstart', data: '' })
    unclaimedOnly.emit({ type: 'compositionupdate', data: 'ㄱ' })
    unclaimedOnly.emit({
      type: 'input',
      inputType: 'insertCompositionText',
      data: 'ㄱ',
      value: 'ㄱ'
    })
    unclaimedOnly.emit({
      type: 'keydown',
      key: 'Process',
      code: 'Backspace',
      keyCode: 229,
      isComposing: true
    })
    unclaimedOnly.emit({ type: 'compositionupdate', data: '' })
    unclaimedOnly.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    unclaimedOnly.emit({ type: 'compositionend', data: '' })

    unclaimedOnly.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyB',
      keyCode: 229,
      isComposing: false
    })
    unclaimedOnly.emit({ type: 'input', inputType: 'insertText', data: 'b', value: '' })
    unclaimedOnly.emit({ type: 'keyup', key: 'b', code: 'KeyB', keyCode: 66, isComposing: false })
    await nextEventLoop()

    expect(unclaimedOnly.emitted()).toBe('b')

    const interleavedSession = await openLinuxPaneReplaySession(KITTY_FLAGS_11)

    interleavedSession.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyR',
      keyCode: 229,
      isComposing: false
    })
    interleavedSession.emit({ type: 'compositionstart', data: '' })
    interleavedSession.emit({ type: 'compositionupdate', data: 'ㄱ' })
    interleavedSession.emit({
      type: 'input',
      inputType: 'insertCompositionText',
      data: 'ㄱ',
      value: 'ㄱ'
    })
    interleavedSession.emit({
      type: 'keydown',
      key: 'Process',
      code: 'Backspace',
      keyCode: 229,
      isComposing: true
    })
    interleavedSession.emit({ type: 'compositionupdate', data: '' })
    interleavedSession.emit({ type: 'input', inputType: 'deleteContentBackward', value: '' })
    interleavedSession.emit({ type: 'compositionend', data: '' })

    // Interleaved claimed 'a', unclaimed Process/229 'b', and claimed Space (with cumulative value 'b ') before finalizer settles.
    interleavedSession.emit({
      type: 'keydown',
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      isComposing: false
    })
    interleavedSession.emit({
      type: 'keypress',
      key: 'a',
      code: 'KeyA',
      keyCode: 97,
      charCode: 97,
      isComposing: false
    })
    interleavedSession.emit({ type: 'input', inputType: 'insertText', data: 'a', value: 'a' })
    interleavedSession.emit({
      type: 'keyup',
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      isComposing: false
    })
    interleavedSession.emit({
      type: 'keydown',
      key: 'Process',
      code: 'KeyB',
      keyCode: 229,
      isComposing: false
    })
    interleavedSession.emit({ type: 'input', inputType: 'insertText', data: 'b', value: 'b' })
    interleavedSession.emit({
      type: 'keyup',
      key: 'b',
      code: 'KeyB',
      keyCode: 66,
      isComposing: false
    })
    interleavedSession.emit({
      type: 'keydown',
      key: ' ',
      code: 'Space',
      keyCode: 32,
      isComposing: false
    })
    interleavedSession.emit({
      type: 'keypress',
      key: ' ',
      code: 'Space',
      keyCode: 32,
      charCode: 32,
      isComposing: false
    })
    interleavedSession.emit({ type: 'input', inputType: 'insertText', data: ' ', value: 'b ' })
    interleavedSession.emit({
      type: 'keyup',
      key: ' ',
      code: 'Space',
      keyCode: 32,
      isComposing: false
    })
    await nextEventLoop()

    expect(interleavedSession.emitted()).toBe('\x1b[97u\x1b[97;1:3ub\x1b[32u\x1b[32;1:3u')
  })
})
