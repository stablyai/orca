import type { XtermBypassEvent } from './xterm-bypass-policy'

// Keep bypass/IME suites aligned with the complete XtermBypassEvent shape.
export function event(overrides: Partial<XtermBypassEvent>): XtermBypassEvent {
  return {
    type: 'keydown',
    key: '',
    code: '',
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}
