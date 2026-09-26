// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  KEYBOARD_SURFACE_ATTRIBUTE,
  keybindingContextForSurface,
  resolveKeyboardShortcutSurface,
  textEntryClaimForSurface
} from './keyboard-shortcut-surface'

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('resolveKeyboardShortcutSurface', () => {
  it('treats a non-element target as app focus', () => {
    expect(resolveKeyboardShortcutSurface(null)).toEqual({ kind: 'app' })
    expect(resolveKeyboardShortcutSurface(document)).toEqual({ kind: 'app' })
  })

  it('treats a plain element as app focus', () => {
    const host = mount('<button type="button">go</button>')

    expect(resolveKeyboardShortcutSurface(host.querySelector('button'))).toEqual({ kind: 'app' })
  })

  it("keeps xterm's helper textarea on the terminal surface", () => {
    const host = mount('<textarea class="xterm-helper-textarea"></textarea>')

    expect(resolveKeyboardShortcutSurface(host.querySelector('textarea'))).toEqual({
      kind: 'terminal'
    })
  })

  it.each([
    ['<input type="text" />', 'input'],
    ['<textarea></textarea>', 'textarea'],
    ['<div contenteditable="true"></div>', 'div']
  ])('blocks %s that declares no surface', (markup, selector) => {
    const host = mount(markup)

    expect(resolveKeyboardShortcutSurface(host.querySelector(selector))).toEqual({
      kind: 'blocked'
    })
  })

  it('reads the claim a declared region publishes', () => {
    const host = mount(
      `<div ${KEYBOARD_SURFACE_ATTRIBUTE}="text-field"><input type="text" /></div>`
    )

    const surface = resolveKeyboardShortcutSurface(host.querySelector('input'))

    expect(surface).toEqual({
      kind: 'text-entry',
      claim: { verticalCaret: false, richTextFormatting: false }
    })
    expect(keybindingContextForSurface(surface)).toBe('text-entry')
    expect(textEntryClaimForSurface(surface)).toEqual({
      verticalCaret: false,
      richTextFormatting: false
    })
  })

  it('never lets a declared region give away a gesture the control itself needs', () => {
    const host = mount(
      `<div ${KEYBOARD_SURFACE_ATTRIBUTE}="text-field">` +
        '<textarea></textarea>' +
        '<input type="number" />' +
        '<div contenteditable="true"><span>rich</span></div>' +
        '</div>'
    )

    expect(
      textEntryClaimForSurface(resolveKeyboardShortcutSurface(host.querySelector('textarea')))
    ).toEqual({ verticalCaret: true, richTextFormatting: false })
    expect(
      textEntryClaimForSurface(resolveKeyboardShortcutSurface(host.querySelector('input')))
    ).toEqual({ verticalCaret: true, richTextFormatting: false })
    expect(
      textEntryClaimForSurface(resolveKeyboardShortcutSurface(host.querySelector('span')))
    ).toEqual({ verticalCaret: true, richTextFormatting: true })
  })

  it('ignores an unknown surface value rather than guessing', () => {
    const host = mount(`<div ${KEYBOARD_SURFACE_ATTRIBUTE}="nonsense"><input type="text" /></div>`)

    expect(resolveKeyboardShortcutSurface(host.querySelector('input'))).toEqual({ kind: 'blocked' })
  })

  it('maps surfaces onto keybinding contexts', () => {
    expect(keybindingContextForSurface({ kind: 'app' })).toBe('app')
    expect(keybindingContextForSurface({ kind: 'terminal' })).toBe('terminal')
    expect(keybindingContextForSurface({ kind: 'blocked' })).toBe('app')
  })
})
