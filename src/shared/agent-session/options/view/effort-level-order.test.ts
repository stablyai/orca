import { describe, expect, it } from 'vitest'
import { orderEffortLevels } from './effort-level-order'

const values = (choices: { value: string }[]) => choices.map((choice) => choice.value)

describe('orderEffortLevels', () => {
  it('puts highest-first agent menus in low to high order', () => {
    const grok = [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }]
    expect(values(orderEffortLevels(grok))).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('keeps unranked entries in their slots', () => {
    const menu = [{ value: 'default' }, { value: 'max' }, { value: 'off' }, { value: 'auto' }]
    expect(values(orderEffortLevels(menu))).toEqual(['default', 'off', 'max', 'auto'])
  })
})
