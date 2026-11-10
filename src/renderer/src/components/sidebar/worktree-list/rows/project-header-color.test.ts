import { expect, it } from 'vitest'
import { resolveSectionHeaderColor } from './project-header-color'

it('normalizes section colors and leaves unset or invalid colors unstyled', () => {
  expect(resolveSectionHeaderColor(' #AbC ')).toBe('#aabbcc')
  expect(resolveSectionHeaderColor('EF4444')).toBe('#ef4444')
  expect(resolveSectionHeaderColor(null)).toBeUndefined()
  expect(resolveSectionHeaderColor(undefined)).toBeUndefined()
  expect(resolveSectionHeaderColor('')).toBeUndefined()
  expect(resolveSectionHeaderColor('red')).toBeUndefined()
})
