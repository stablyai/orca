import type { XtermBypassEvent } from './xterm-bypass-policy'

// Shared test fixture: builds a fully-defaulted XtermBypassEvent so the bypass
// and IME candidate-guard suites all stay in sync when the event shape changes.
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
