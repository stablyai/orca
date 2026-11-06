import { describe, expect, it } from 'vitest'
import { CARD_TEMPLATE_LIMITS, cardTemplateSchema } from './card-template-schema'

const minimal = { version: 1, facts: 1, root: { el: 'Row', children: [{ el: 'Title' }] } }

describe('card template schema', () => {
  it('refuses unknown keys, bad names and non-JSON prop values', () => {
    for (const bad of [
      { ...minimal, extra: true },
      { ...minimal, root: { el: 'div' } },
      { ...minimal, root: { el: 'Row', props: { onClick: { fn: 1 } } } },
      { ...minimal, root: { el: 'Row', props: { 'bad-name': 1 } } },
      { ...minimal, vars: { '1x': 'true' } },
      { ...minimal, version: 2 }
    ]) {
      expect(cardTemplateSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('caps node count and depth', () => {
    const wide = {
      ...minimal,
      root: {
        el: 'Row',
        children: Array.from({ length: CARD_TEMPLATE_LIMITS.maxNodes }, () => ({ el: 'Title' }))
      }
    }
    expect(cardTemplateSchema.safeParse(wide).success).toBe(false)
    let deep: Record<string, unknown> = { el: 'Title' }
    for (let i = 0; i < CARD_TEMPLATE_LIMITS.maxDepth + 1; i++) {
      deep = { el: 'Row', children: [deep] }
    }
    expect(cardTemplateSchema.safeParse({ ...minimal, root: deep }).success).toBe(false)
  })
})
