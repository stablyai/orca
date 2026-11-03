import { describe, expect, it } from 'vitest'
import { PLUGIN_CARDS_API } from './plugin-host-api-cards'

const params = PLUGIN_CARDS_API['cards.setFields'].params

describe('cards.setFields params', () => {
  it('takes small scalar fields or null', () => {
    expect(
      params.safeParse({ workspaceId: 'wt', fields: { due: 'mon', count: 2, late: true, x: null } })
        .success
    ).toBe(true)
    expect(params.safeParse({ workspaceId: 'wt', fields: null }).success).toBe(true)
  })

  it('refuses nested values, too many keys and more than 4 KiB', () => {
    expect(params.safeParse({ workspaceId: 'wt', fields: { due: { day: 1 } } }).success).toBe(false)
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))
    expect(params.safeParse({ workspaceId: 'wt', fields: many }).success).toBe(false)
    const big = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]))
    expect(params.safeParse({ workspaceId: 'wt', fields: big }).success).toBe(false)
  })
})
