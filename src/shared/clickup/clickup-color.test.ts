import { expect, it } from 'vitest'
import { safeClickUpColor } from './clickup-color'

it('lets only plain hex colors reach a style', () => {
  expect(safeClickUpColor('#a875ff')).toBe('#a875ff')
  expect(safeClickUpColor('red; background: url(x)')).toBeUndefined()
  expect(safeClickUpColor('')).toBeUndefined()
})
