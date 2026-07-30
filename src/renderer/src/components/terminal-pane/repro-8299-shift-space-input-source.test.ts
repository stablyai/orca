/**
 * Issue #8299 — macOS Shift+Space input-source switch also sent a literal space.
 *
 * Regression: with terminal.switchInputSource bound to Shift+Space, the chord
 * resolves to the native-only action (no PTY bytes) while unbound Shift+Space
 * stays ordinary terminal input. Companion keypress/keyup are suppressible.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/terminal-pane/repro-8299-shift-space-input-source.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  createTerminalNativeOnlyShortcutTracker,
  getTerminalShortcutKeyIdentity
} from './terminal-native-only-shortcut'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'
import { shouldBypassXtermKeyboardEvent, type XtermBypassEvent } from './xterm-bypass-policy'

function shortcutEvent(
  partial: Partial<TerminalShortcutEvent> & Pick<TerminalShortcutEvent, 'key'>
): TerminalShortcutEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial
  }
}

function bypassEvent(
  partial: Partial<XtermBypassEvent> & Pick<XtermBypassEvent, 'type' | 'key'>
): XtermBypassEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial
  }
}

describe('issue #8299 Shift+Space input-source switch regression', () => {
  it('does not globally steal Shift+Space via xterm bypass (opt-in only)', () => {
    const opts = { isMac: true, hasSelection: false }
    for (const type of ['keydown', 'keyup'] as const) {
      expect(
        shouldBypassXtermKeyboardEvent(
          bypassEvent({ type, key: ' ', code: 'Space', shiftKey: true }),
          opts
        )
      ).toBe(false)
    }
  })

  it('configures Shift+Space as native-only input-source switch without sendInput', () => {
    const overrides = { 'terminal.switchInputSource': ['Shift+Space'] }
    const action = resolveTerminalShortcutAction(
      shortcutEvent({ key: ' ', code: 'Space', shiftKey: true }),
      true,
      'false',
      0,
      false,
      overrides
    )
    expect(action).toEqual({ type: 'switchInputSource' })
    expect(action).not.toMatchObject({ type: 'sendInput' })
  })

  it('leaves unbound Shift+Space as non-action on macOS/Linux/Windows', () => {
    // Why: native-only behavior is opt-in; non-IME users keep ordinary Space input.
    for (const [isMac, isWindows] of [
      [true, false],
      [false, false],
      [false, true]
    ] as const) {
      expect(
        resolveTerminalShortcutAction(
          shortcutEvent({ key: ' ', code: 'Space', shiftKey: true }),
          isMac,
          'false',
          0,
          isWindows
        )
      ).toBeNull()
    }
  })

  it('resolves held Shift+Space repeats as native-only (Korean IME chord hold)', () => {
    const overrides = { 'terminal.switchInputSource': ['Shift+Space'] }
    expect(
      resolveTerminalShortcutAction(
        shortcutEvent({ key: ' ', code: 'Space', shiftKey: true, repeat: true }),
        true,
        'false',
        0,
        false,
        overrides
      )
    ).toEqual({ type: 'switchInputSource' })
  })

  it('supports alternate OS chords such as Ctrl+Space', () => {
    const overrides = { 'terminal.switchInputSource': ['Ctrl+Space'] }
    expect(
      resolveTerminalShortcutAction(
        shortcutEvent({ key: ' ', code: 'Space', ctrlKey: true }),
        false,
        'false',
        0,
        false,
        overrides
      )
    ).toEqual({ type: 'switchInputSource' })
  })

  it('suppresses keypress/keyup companions including keypress without code', () => {
    // Why: Chromium keypress may omit code and only report key:" ".
    const tracker = createTerminalNativeOnlyShortcutTracker()
    tracker.armKeyDown(shortcutEvent({ key: ' ', code: 'Space', shiftKey: true }))
    expect(tracker.consumeCompanion({ type: 'keypress', key: ' ' })).toBe(true)
    expect(tracker.consumeCompanion({ type: 'keyup', key: ' ' })).toBe(true)
    expect(tracker.consumeCompanion({ type: 'keyup', key: ' ' })).toBe(false)
  })

  it('normalizes Space identities across key/code aliases', () => {
    expect(getTerminalShortcutKeyIdentity({ key: ' ', code: 'Space' })).toBe('Space')
    expect(getTerminalShortcutKeyIdentity({ key: ' ' })).toBe('Space')
    expect(getTerminalShortcutKeyIdentity({ key: 'Spacebar' })).toBe('Space')
    expect(getTerminalShortcutKeyIdentity({ key: 'a', code: 'KeyA' })).toBe('KeyA')
  })

  it('does not suppress unrelated companions while Space is pending', () => {
    const tracker = createTerminalNativeOnlyShortcutTracker()
    tracker.armKeyDown({ key: ' ', code: 'Space' })
    expect(tracker.consumeCompanion({ type: 'keypress', key: 'a', code: 'KeyA' })).toBe(false)
    expect(tracker.consumeCompanion({ type: 'keydown', key: ' ', code: 'Space' })).toBe(false)
    expect(tracker.consumeCompanion({ type: 'keypress', key: ' ' })).toBe(true)
  })

  it('keeps Space armed through unrelated key rollover until its keyup', () => {
    const tracker = createTerminalNativeOnlyShortcutTracker()
    tracker.armKeyDown({ key: ' ', code: 'Space' })
    tracker.prepareKeyDown({ key: 'a', code: 'KeyA' })

    expect(
      tracker.shouldSuppressBeforeInput({ data: 'a', inputType: 'insertText', isComposing: false })
    ).toBe(false)
    expect(tracker.consumeCompanion({ type: 'keyup', key: ' ', code: 'Space' })).toBe(true)
  })

  it('replaces stale state when the same physical key is pressed again', () => {
    const tracker = createTerminalNativeOnlyShortcutTracker()
    tracker.armKeyDown({ key: ' ', code: 'Space' })
    tracker.prepareKeyDown({ key: ' ', code: 'Space' })

    expect(tracker.consumeCompanion({ type: 'keyup', key: ' ', code: 'Space' })).toBe(false)
  })

  it('suppresses only the shortcut text on the beforeinput fallback', () => {
    const tracker = createTerminalNativeOnlyShortcutTracker()
    tracker.armKeyDown({ key: ' ', code: 'Space' })
    expect(
      tracker.shouldSuppressBeforeInput({ data: ' ', inputType: 'insertText', isComposing: false })
    ).toBe(true)
    expect(
      tracker.shouldSuppressBeforeInput({ data: '한', inputType: 'insertText', isComposing: false })
    ).toBe(false)
    expect(
      tracker.shouldSuppressBeforeInput({
        data: ' ',
        inputType: 'insertCompositionText',
        isComposing: true
      })
    ).toBe(false)
  })
})
