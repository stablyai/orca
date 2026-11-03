import { describe, expect, it } from 'vitest'
import {
  CARD_FACT_PATHS,
  cardFactPathIssue
} from '../../../../../../shared/workspace-cards/card-fact-paths'
import { previewFacts } from './card-preview-scenario'

function leafPaths(value: unknown, prefix: string[]): string[][] {
  if (Array.isArray(value) || typeof value !== 'object' || value === null) {
    return [prefix]
  }
  const entries = Object.entries(value)
  return entries.length === 0
    ? [prefix]
    : entries.flatMap(([key, child]) => leafPaths(child, [...prefix, key]))
}

describe('card fact paths', () => {
  it('names every fact a complete card has, and nothing it lacks', () => {
    const facts = previewFacts({ review: { number: 1 } })
    for (const path of leafPaths(facts, [])) {
      expect(cardFactPathIssue(path, null), path.join('.')).toBeNull()
    }
    for (const root of Object.keys(CARD_FACT_PATHS)) {
      if (root !== 'vars') {
        expect(Object.hasOwn(facts, root), root).toBe(true)
      }
    }
    expect(cardFactPathIssue(['ws', 'nmae'], null)).toMatch(/unknown fact ws\.nmae/)
    expect(cardFactPathIssue(['fields', 'anything'], null)).toBeNull()
  })
})
