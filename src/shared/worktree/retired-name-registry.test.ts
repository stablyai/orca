import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from '../marine-creatures'
import { selectSuggestedCreatureName } from '../worktree-name-suggestion'
import {
  addRetiredNames,
  clampExhaustedTiers,
  compactRetiredNames,
  createRetiredNameLookup,
  creatureNameTier,
  EMPTY_RETIRED_NAME_REGISTRY,
  mergeRetiredNameRegistries
} from './retired-name-registry'

const POOL = MARINE_CREATURES.map((name) => name.toLowerCase())
const tier = (n: number) => POOL.map((name) => (n === 1 ? name : `${name}-${n}`))

describe('creatureNameTier', () => {
  it.each([
    ['nautilus', 1],
    ['Nautilus', 1],
    ['  nautilus  ', 1],
    ['nautilus-2', 2],
    ['nautilus-10', 10],
    ['nautilus-999999', 999999]
  ])('reads %s as tier %s', (name, expected) => {
    expect(creatureNameTier(name)).toBe(expected)
  })

  it.each([
    // A user-typed name must never be covered by a watermark, or a spent tier would silently
    // retire names the pool has no claim on.
    ['fix-login-2'],
    ['fix-login'],
    // The suggester never emits these, so no tier can ever complete for them.
    ['nautilus-2-3'],
    ['nautilus-1'],
    ['nautilus-0'],
    ['nautilus-02'],
    ['nautilus-1000000']
  ])('leaves %s outside every tier', (name) => {
    expect(creatureNameTier(name)).toBeNull()
  })
})

describe('compactRetiredNames', () => {
  it('does not move the watermark while one name of the tier is missing', () => {
    const registry = compactRetiredNames({ exhaustedTiers: 0, names: POOL.slice(0, -1) })
    expect(registry.exhaustedTiers).toBe(0)
    expect(registry.names.length).toBe(POOL.length - 1)
  })

  it('folds a completed tier into the watermark and drops its names', () => {
    expect(compactRetiredNames({ exhaustedTiers: 0, names: tier(1) })).toEqual({
      exhaustedTiers: 1,
      names: []
    })
  })

  it('rolls through consecutive tiers that completed out of order', () => {
    const registry = compactRetiredNames({
      exhaustedTiers: 0,
      names: [...tier(3), ...tier(2), ...tier(1)]
    })
    expect(registry).toEqual({ exhaustedTiers: 3, names: [] })
  })

  it('stops at the first incomplete tier and keeps everything above it', () => {
    const registry = compactRetiredNames({
      exhaustedTiers: 0,
      names: [...tier(1), 'nautilus-3', 'nautilus-2-3']
    })
    expect(registry.exhaustedTiers).toBe(1)
    expect([...registry.names].sort()).toEqual(['nautilus-2-3', 'nautilus-3'])
  })

  it('drops names a higher watermark already covers', () => {
    expect(
      compactRetiredNames({ exhaustedTiers: 2, names: ['nautilus', 'orca-2', 'orca-3'] })
    ).toEqual({ exhaustedTiers: 2, names: ['orca-3'] })
  })

  it.each([
    ['a negative watermark', -1],
    ['a fractional watermark', 1.5],
    ['a non-number watermark', 'many'],
    ['no watermark', undefined]
  ])('clamps %s to none rather than trusting it', (_label, value) => {
    expect(clampExhaustedTiers(value)).toBe(0)
    expect(compactRetiredNames({ exhaustedTiers: value as number, names: [] }).exhaustedTiers).toBe(
      0
    )
  })
})

describe('createRetiredNameLookup', () => {
  it('reports a compacted tier as retired without listing its names', () => {
    const lookup = createRetiredNameLookup({ exhaustedTiers: 2, names: [] })
    expect(POOL.every((name) => lookup(name))).toBe(true)
    expect(POOL.every((name) => lookup(`${name}-2`))).toBe(true)
    expect(lookup('nautilus-3')).toBe(false)
  })

  it('does not retire a user-typed name that merely ends in a spent tier number', () => {
    expect(createRetiredNameLookup({ exhaustedTiers: 5, names: [] })('fix-login-2')).toBe(false)
  })

  it('still answers for explicit names above the watermark', () => {
    const lookup = createRetiredNameLookup({ exhaustedTiers: 1, names: ['nautilus-3'] })
    expect(lookup('NAUTILUS-3')).toBe(true)
    expect(lookup('orca-3')).toBe(false)
  })
})

describe('addRetiredNames', () => {
  it('reports no change when every name is already covered by the watermark', () => {
    expect(addRetiredNames({ exhaustedTiers: 1, names: [] }, ['nautilus'])).toBeNull()
  })

  it('compacts as soon as the added name completes the tier', () => {
    const before = { exhaustedTiers: 0, names: POOL.slice(0, -1) }
    expect(addRetiredNames(before, [POOL.at(-1) as string])).toEqual({
      exhaustedTiers: 1,
      names: []
    })
  })

  it('keeps an out-of-order higher-tier name through a lower tier compacting', () => {
    const before = { exhaustedTiers: 0, names: [...POOL.slice(0, -1), 'nautilus-2'] }
    expect(addRetiredNames(before, [POOL.at(-1) as string])).toEqual({
      exhaustedTiers: 1,
      names: ['nautilus-2']
    })
  })
})

describe('mergeRetiredNameRegistries', () => {
  it('takes the higher watermark and drops what it covers', () => {
    expect(
      mergeRetiredNameRegistries(
        { exhaustedTiers: 2, names: ['nautilus-3'] },
        { exhaustedTiers: 0, names: ['nautilus', 'orca-2', 'seahorse-4'] }
      )
    ).toEqual({ exhaustedTiers: 2, names: ['nautilus-3', 'seahorse-4'] })
  })

  it('completes a tier out of two partial peers', () => {
    const half = Math.floor(POOL.length / 2)
    expect(
      mergeRetiredNameRegistries(
        { exhaustedTiers: 0, names: POOL.slice(0, half) },
        { exhaustedTiers: 0, names: POOL.slice(half) }
      )
    ).toEqual({ exhaustedTiers: 1, names: [] })
  })
})

describe('end-to-end retirement guarantee', () => {
  const pickFirst = () => 0

  it('never suggests a name that has been retired, compacted or not', () => {
    let registry = EMPTY_RETIRED_NAME_REGISTRY
    const issued: string[] = []
    // Two full tiers plus one, so the run crosses compaction twice and lands above the watermark.
    for (let index = 0; index < POOL.length * 2 + 1; index += 1) {
      const name = selectSuggestedCreatureName(registry.names, pickFirst, registry.exhaustedTiers)
      expect(issued).not.toContain(name)
      issued.push(name)
      registry = addRetiredNames(registry, [name]) ?? registry
    }

    expect(new Set(issued).size).toBe(issued.length)
    expect(registry).toEqual({ exhaustedTiers: 2, names: [`${POOL[0]}-3`] })
    const isRetired = createRetiredNameLookup(registry)
    expect(issued.every((name) => isRetired(name))).toBe(true)
  })
})
