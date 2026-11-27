import { expect, it } from 'vitest'
import { holdsDigitIndexModifiers } from './digit-index-modifier-hold'

const held = (input: {
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}) => input

it('follows the platform Mod, remapped chords, and an unbound action', () => {
  const id = 'workspace.selectByIndex'
  expect(holdsDigitIndexModifiers(id, held({ metaKey: true }), 'darwin')).toBe(true)
  expect(holdsDigitIndexModifiers(id, held({ ctrlKey: true }), 'darwin')).toBe(false)
  expect(holdsDigitIndexModifiers(id, held({ metaKey: true, shiftKey: true }), 'darwin')).toBe(
    false
  )
  expect(holdsDigitIndexModifiers(id, held({ ctrlKey: true }), 'linux')).toBe(true)
  expect(holdsDigitIndexModifiers(id, held({ ctrlKey: true }), 'win32')).toBe(true)

  const remapped = { [id]: ['Ctrl+Alt+1'] }
  expect(holdsDigitIndexModifiers(id, held({ metaKey: true }), 'darwin', remapped)).toBe(false)
  expect(
    holdsDigitIndexModifiers(id, held({ ctrlKey: true, altKey: true }), 'darwin', remapped)
  ).toBe(true)

  const unbound = { [id]: [] }
  expect(holdsDigitIndexModifiers(id, held({ metaKey: true }), 'darwin', unbound)).toBe(false)
  expect(holdsDigitIndexModifiers(id, held({ ctrlKey: true }), 'linux', unbound)).toBe(false)
})
