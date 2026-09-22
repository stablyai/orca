import { describe, expect, it } from 'vitest'
import {
  handleActivityFilterFocusShortcut,
  isActivityFilterFocusShortcut,
  shouldIgnoreActivityFilterFocusShortcutTarget
} from './ActivityPrototypePage'

describe('activity filter focus shortcut', () => {
  it('matches Cmd+F on Mac and Ctrl+F elsewhere without extra modifiers', () => {
    expect(
      isActivityFilterFocusShortcut(
        { key: 'f', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        true
      )
    ).toBe(true)
    expect(
      isActivityFilterFocusShortcut(
        { key: 'F', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
        false
      )
    ).toBe(true)
    expect(
      isActivityFilterFocusShortcut(
        { key: 'f', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
        true
      )
    ).toBe(false)
    expect(
      isActivityFilterFocusShortcut(
        { key: 'f', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
        true
      )
    ).toBe(false)
    expect(
      isActivityFilterFocusShortcut(
        { key: 'f', metaKey: true, ctrlKey: true, shiftKey: false, altKey: false },
        true
      )
    ).toBe(false)
    expect(
      isActivityFilterFocusShortcut(
        { key: 'f', metaKey: true, ctrlKey: true, shiftKey: false, altKey: false },
        false
      )
    ).toBe(false)
  })

  it('prevents default, focuses, and selects only for handled filter shortcuts', () => {
    let prevented = 0
    let stopped = 0
    let stoppedImmediate = 0
    let focused = 0
    let selected = 0
    const input = {
      focus: () => {
        focused += 1
      },
      select: () => {
        selected += 1
      }
    } as Pick<HTMLInputElement, 'focus' | 'select'>
    const activeElement = {
      classList: { contains: () => false }
    } as unknown as Element
    const terminalElement = {
      classList: { contains: (className: string) => className === 'xterm-helper-textarea' }
    } as unknown as Element
    const terminalPortalTarget = {
      contains: (target: Element) => target === terminalElement
    } as unknown as HTMLElement

    expect(
      handleActivityFilterFocusShortcut({
        activeElement,
        event: {
          key: 'f',
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          preventDefault: () => {
            prevented += 1
          },
          stopPropagation: () => {
            stopped += 1
          },
          stopImmediatePropagation: () => {
            stoppedImmediate += 1
          }
        },
        input,
        isMac: true,
        terminalPortalTargets: []
      })
    ).toBe(true)
    expect(prevented).toBe(1)
    expect(stopped).toBe(1)
    expect(stoppedImmediate).toBe(1)
    expect(focused).toBe(1)
    expect(selected).toBe(1)

    expect(
      handleActivityFilterFocusShortcut({
        activeElement: terminalElement,
        event: {
          key: 'f',
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          preventDefault: () => {
            prevented += 1
          },
          stopPropagation: () => {
            stopped += 1
          },
          stopImmediatePropagation: () => {
            stoppedImmediate += 1
          }
        },
        input,
        isMac: true,
        terminalPortalTargets: [terminalPortalTarget]
      })
    ).toBe(false)
    expect(prevented).toBe(1)
    expect(stopped).toBe(1)
    expect(stoppedImmediate).toBe(1)
    expect(focused).toBe(1)
    expect(selected).toBe(1)
  })

  it('does not prevent default when the filter input is unavailable', () => {
    let prevented = 0
    const activeElement = {
      classList: { contains: () => false }
    } as unknown as Element

    expect(
      handleActivityFilterFocusShortcut({
        activeElement,
        event: {
          key: 'f',
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          preventDefault: () => {
            prevented += 1
          },
          stopPropagation: () => {
            throw new Error('unavailable input must not stop propagation')
          },
          stopImmediatePropagation: () => {
            throw new Error('unavailable input must not stop immediate propagation')
          }
        },
        input: null,
        isMac: true,
        terminalPortalTargets: []
      })
    ).toBe(false)
    expect(prevented).toBe(0)
  })

  it('ignores shortcut handling while terminal-owned elements have focus', () => {
    const terminalTextarea = {
      classList: { contains: (className: string) => className === 'xterm-helper-textarea' }
    } as unknown as Element
    const portalChild = {
      classList: { contains: () => false }
    } as unknown as Element
    const outside = {
      classList: { contains: () => false }
    } as unknown as Element
    const portalTarget = {
      contains: (target: Element) => target === portalChild || target === terminalTextarea
    } as unknown as HTMLElement
    const hiddenWorkbenchTerminal = {
      classList: { contains: (className: string) => className === 'xterm-helper-textarea' }
    } as unknown as Element
    expect(shouldIgnoreActivityFilterFocusShortcutTarget(terminalTextarea, [portalTarget])).toBe(
      true
    )
    expect(shouldIgnoreActivityFilterFocusShortcutTarget(portalChild, [portalTarget])).toBe(true)
    expect(shouldIgnoreActivityFilterFocusShortcutTarget(outside, [portalTarget])).toBe(false)
    expect(
      shouldIgnoreActivityFilterFocusShortcutTarget(hiddenWorkbenchTerminal, [portalTarget])
    ).toBe(false)
  })
})
