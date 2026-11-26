import { expect, it } from 'vitest'
import { normalizeKeybinding, normalizeKeybindingArrayWithOptions } from './normalization'

it('accepts literal + and , keys in bindings, lists and arrays', () => {
  expect(normalizeKeybinding('Mod++')).toEqual({ ok: true, value: 'Mod+Plus' })
  expect(normalizeKeybinding('Ctrl + Shift + +')).toEqual({ ok: true, value: 'Ctrl+Shift+Plus' })
  expect(
    normalizeKeybindingArrayWithOptions(['Ctrl+,', 'Mod++, Mod+ ,, Ctrl+Shift+,', 'Mod+K'])
  ).toEqual(['Ctrl+Comma', 'Mod+Plus', 'Mod+Comma', 'Ctrl+Shift+Comma', 'Mod+K'])
})

it('keeps lenient typos like Mod++K loading and rejects ambiguous trailing commas', () => {
  expect(normalizeKeybindingArrayWithOptions(['Mod++K', 'Mod+K+, Mod+P'])).toEqual([
    'Mod+K',
    'Mod+P'
  ])
  for (const list of ['Mod++,', 'Mod+,,', 'Mod+K,']) {
    expect(normalizeKeybindingArrayWithOptions([list])).toMatchObject({
      errorCode: 'invalidFormat'
    })
  }
})
