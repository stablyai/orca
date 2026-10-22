import { expect, it } from 'vitest'
import { isPaletteNavigationKeyDown } from './palette-keyboard-navigation'

it.each(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'])(
  'recognizes %s as navigation',
  (key) => {
    expect(isPaletteNavigationKeyDown({ key, ctrlKey: false, defaultPrevented: false })).toBe(true)
  }
)

it.each(['n', 'p', 'j', 'k'])('recognizes only the Control binding for %s', (key) => {
  expect(isPaletteNavigationKeyDown({ key, ctrlKey: true, defaultPrevented: false })).toBe(true)
  expect(isPaletteNavigationKeyDown({ key, ctrlKey: false, defaultPrevented: false })).toBe(false)
})

it.each([
  { key: 'Enter' },
  { key: 'Tab' },
  { key: 'N' },
  { defaultPrevented: true },
  { isComposing: true },
  { keyCode: 229 },
  { nativeEvent: { isComposing: true } },
  { nativeEvent: { keyCode: 229 } }
])('ignores activation, unrelated, consumed and IME events: %j', (override) => {
  expect(
    isPaletteNavigationKeyDown({
      key: 'ArrowDown',
      ctrlKey: true,
      defaultPrevented: false,
      ...override
    })
  ).toBe(false)
})
