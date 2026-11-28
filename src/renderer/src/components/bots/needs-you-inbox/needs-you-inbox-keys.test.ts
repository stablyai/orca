// @vitest-environment happy-dom
import type React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { escapeStaysInComposer, needsYouInboxKey } from './needs-you-inbox-keys'

type KeyInit = Partial<{
  key: string
  repeat: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  isComposing: boolean
  target: EventTarget
}>

function press(init: KeyInit): React.KeyboardEvent {
  const list = document.createElement('div')
  const event = {
    key: 'j',
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: list,
    ...init,
    nativeEvent: { isComposing: init.isComposing === true, keyCode: 0 }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader takes only these fields of a React keyboard event.
  return event as unknown as React.KeyboardEvent
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('needsYouInboxKey', () => {
  it('maps each list key to its action', () => {
    const cases: [string, unknown][] = [
      ['j', { kind: 'step', direction: 1 }],
      ['ArrowDown', { kind: 'step', direction: 1 }],
      ['k', { kind: 'step', direction: -1 }],
      ['ArrowUp', { kind: 'step', direction: -1 }],
      ['g', { kind: 'group' }],
      ['i', { kind: 'reply' }],
      ['r', { kind: 'reply' }],
      ['Enter', { kind: 'open' }],
      ['e', { kind: 'done' }],
      ['s', { kind: 'snooze' }],
      ['1', { kind: 'answer', digit: 1 }],
      ['9', { kind: 'answer', digit: 9 }]
    ]
    for (const [key, action] of cases) {
      expect(needsYouInboxKey(press({ key })), key).toEqual(action)
    }
  })

  it('takes no other key, and no 0', () => {
    for (const key of ['0', 'x', 'J', 'Escape', ' ', 'Tab', 'toString', 'constructor']) {
      expect(needsYouInboxKey(press({ key })), key).toBeNull()
    }
  })

  it('leaves chords, IME composition, handled events and text fields alone', () => {
    expect(needsYouInboxKey(press({ key: 'e', metaKey: true }))).toBeNull()
    expect(needsYouInboxKey(press({ key: 'e', ctrlKey: true }))).toBeNull()
    expect(needsYouInboxKey(press({ key: '1', altKey: true }))).toBeNull()
    expect(needsYouInboxKey(press({ key: 'e', isComposing: true }))).toBeNull()
    expect(needsYouInboxKey(press({ key: 'e', defaultPrevented: true }))).toBeNull()
    const field = document.createElement('textarea')
    expect(needsYouInboxKey(press({ key: 'e', target: field }))).toBeNull()
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    document.body.append(editor)
    expect(needsYouInboxKey(press({ key: '1', target: editor }))).toBeNull()
  })

  it('repeats only movement while a key is held', () => {
    expect(needsYouInboxKey(press({ key: 'j', repeat: true }))).toEqual({
      kind: 'step',
      direction: 1
    })
    expect(needsYouInboxKey(press({ key: 'ArrowUp', repeat: true }))).toEqual({
      kind: 'step',
      direction: -1
    })
    for (const key of ['e', 's', '1', 'i', 'Enter', 'g']) {
      expect(needsYouInboxKey(press({ key, repeat: true })), key).toBeNull()
    }
  })
})

describe('escapeStaysInComposer', () => {
  it('keeps Escape in a box with words or an open suggestion list, not in an empty one', () => {
    const box = document.createElement('div')
    document.body.append(box)
    expect(escapeStaysInComposer(box)).toBe(false)
    box.textContent = '   '
    expect(escapeStaysInComposer(box)).toBe(false)
    box.textContent = 'a draft'
    expect(escapeStaysInComposer(box)).toBe(true)
    box.textContent = ''
    const suggestions = document.createElement('div')
    suggestions.setAttribute('data-focus-behavior', 'composer-suggestions')
    document.body.append(suggestions)
    expect(escapeStaysInComposer(box)).toBe(true)
  })
})
