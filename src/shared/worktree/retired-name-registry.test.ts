import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from '../marine-creatures'
import { selectSuggestedCreatureName } from '../worktree-name-suggestion'
import {
  addRetiredNames,
  createRetiredNameLookup,
  EMPTY_RETIRED_NAME_REGISTRY
} from './retired-name-registry'

const POOL = MARINE_CREATURES.map((name) => name.toLowerCase())

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
