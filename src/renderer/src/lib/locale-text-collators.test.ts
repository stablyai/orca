import { describe, expect, it, vi } from 'vitest'
import { compareBaseSensitivityLocaleText, compareNumericLocaleText } from './locale-text-collators'

function expectComparatorParity(
  values: readonly string[],
  legacy: (a: string, b: string) => number,
  current: (a: string, b: string) => number
): void {
  for (const a of values) {
    for (const b of values) {
      expect(Math.sign(current(a, b))).toBe(Math.sign(legacy(a, b)))
    }
  }
  expect([...values].sort(current)).toEqual([...values].sort(legacy))
}

describe('locale text collators', () => {
  it('preserves base-sensitivity localeCompare ordering', () => {
    const values = [
      'zeta',
      'Zeta',
      'Álpha',
      'alpha',
      'BÉTA',
      'beta',
      'café',
      'Cafe',
      'a-b',
      'a b',
      'a_b',
      'Ångström',
      'alpha'
    ]
    const legacy = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

    expectComparatorParity(values, legacy, compareBaseSensitivityLocaleText)
  })

  it('preserves numeric localeCompare ordering and ties', () => {
    const values = [
      'TASK-10',
      'TASK-2',
      'TASK-02',
      'TASK-1',
      'TASK-20',
      'TASK-11',
      'TASK_2',
      'task-2',
      'TASK-2'
    ]
    const legacy = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

    expectComparatorParity(values, legacy, compareNumericLocaleText)
  })

  it('constructs each collator only when its comparison mode is first used', async () => {
    vi.resetModules()
    const NativeCollator = Intl.Collator
    const collatorSpy = vi
      .spyOn(Intl, 'Collator')
      .mockImplementation(function Collator(locales, options) {
        return new NativeCollator(locales, options)
      })
    try {
      const comparison = await import('./locale-text-collators')
      expect(collatorSpy).not.toHaveBeenCalled()
      comparison.compareNumericLocaleText('TASK-2', 'TASK-10')
      comparison.compareNumericLocaleText('TASK-3', 'TASK-11')
      expect(collatorSpy).toHaveBeenCalledTimes(1)
      comparison.compareBaseSensitivityLocaleText('café', 'Cafe')
      comparison.compareBaseSensitivityLocaleText('Álpha', 'alpha')
      expect(collatorSpy).toHaveBeenCalledTimes(2)
    } finally {
      collatorSpy.mockRestore()
    }
  })
})
