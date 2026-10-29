import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from '../marine-creatures'
import { selectSuggestedCreatureName } from '../worktree-name-suggestion'
import {
  addRetiredNames,
  createRetiredNameLookup,
  EMPTY_RETIRED_NAME_REGISTRY,
  mergeRetiredNameRegistries
} from './retired-name-registry'

const POOL = MARINE_CREATURES.map((name) => name.toLowerCase())

describe('createRetiredNameLookup', () => {
  it('does not retire a user-typed name that merely ends in a spent tier number', () => {
    expect(createRetiredNameLookup({ exhaustedTiers: 5, names: [] })('fix-login-2')).toBe(false)
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
    // Cross compaction twice and finish above the watermark.
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
