// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { resolveKeyboardShortcutSurface } from './keyboard-shortcut-surface'

function target(markup: string, selector: string): Element | null {
  const host = document.createElement('div')
  host.innerHTML = markup
  document.body.appendChild(host)
  return host.querySelector(selector)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('search field shortcut opt-in', () => {
  it('keeps non-editable and terminal contexts', () => {
    expect(resolveKeyboardShortcutSurface(null)).toBe('app')
    expect(resolveKeyboardShortcutSurface(document)).toBe('app')
    expect(resolveKeyboardShortcutSurface(target('<button>go</button>', 'button'))).toBe('app')
    expect(
      resolveKeyboardShortcutSurface(
        target('<textarea class="xterm-helper-textarea"></textarea>', 'textarea')
      )
    ).toBe('terminal')
  })

  it.each(['text', 'search'])('allows only a declared %s input', (type) => {
    expect(
      resolveKeyboardShortcutSurface(
        target(`<input type="${type}" data-keyboard-surface="search-field" />`, 'input')
      )
    ).toBe('search-field')
  })

  it.each([
    'nonsense',
    'constructor',
    'toString',
    '__proto__',
    'text-field',
    'text-editor',
    'rich-text'
  ])('blocks an unknown declaration %s', (value) => {
    expect(
      resolveKeyboardShortcutSurface(
        target(`<input type="text" data-keyboard-surface="${value}" />`, 'input')
      )
    ).toBe('blocked')
  })

  it.each([
    ['<input type="text" />', 'input'],
    ['<input type="number" data-keyboard-surface="search-field" />', 'input'],
    ['<input type="date" data-keyboard-surface="search-field" />', 'input'],
    ['<textarea data-keyboard-surface="search-field"></textarea>', 'textarea'],
    ['<select data-keyboard-surface="search-field"><option>one</option></select>', 'select'],
    [
      '<div contenteditable="true" data-keyboard-surface="search-field"><span>rich</span></div>',
      'span'
    ]
  ])('keeps %s blocked under a declaration', (markup, selector) => {
    expect(
      resolveKeyboardShortcutSurface(
        target(`<div data-keyboard-surface="search-field">${markup}</div>`, selector)
      )
    ).toBe('blocked')
  })
})
