import { expect, it } from 'vitest'
import { FileInventoryBudget, FileInventoryCapacityError } from './file-inventory-budget'

it('accepts the retained-byte boundary and rejects the next entry', () => {
  const budget = new FileInventoryBudget(132)
  budget.record('a')
  budget.record('b')
  expect(() => budget.record('c')).toThrow(FileInventoryCapacityError)
})

it('charges serialized escaping and rejects an oversized individual path', () => {
  const escaped = new FileInventoryBudget(100)
  expect(() => escaped.record('\u0001'.repeat(20))).toThrow(FileInventoryCapacityError)
  expect(() => new FileInventoryBudget().record('x'.repeat(65537))).toThrow(
    FileInventoryCapacityError
  )
})
