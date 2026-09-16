import { describe, expect, it } from 'vitest'
import {
  ALL_CAPS_CONSTANT_RULE,
  FUNCTION_CALL_RULE,
  HEURISTIC_IDENTIFIER_TOKEN_RULES,
  NAMESPACE_ACCESS_RULE
} from './heuristic-identifier-token-rules'

// Why matchAtStart, not pattern.test(): Monaco's Monarch engine anchors every
// rule at the current tokenizer position (it compiles each pattern as
// `^(?:...)`), so a rule only "matches" a candidate string when the match
// starts at index 0 — never partway through, the way a bare .test() would
// happily report for e.g. /Flags/ inside "featureFlags". These regexes are
// intentionally unanchored (a literal `^` would flip Monaco's own
// `matchOnlyAtLineStart` compiler flag — see monarchCompile.js), so tests
// simulate that same anchoring by hand instead.
function matchAtStart(pattern: RegExp, input: string): boolean {
  const match = pattern.exec(input)
  return match !== null && match.index === 0
}

describe('FUNCTION_CALL_RULE', () => {
  const [pattern] = FUNCTION_CALL_RULE

  it('matches an identifier immediately followed by "("', () => {
    expect(matchAtStart(pattern, 'loadActiveWorktree(')).toBe(true)
    expect(matchAtStart(pattern, 'loadActiveWorktree (')).toBe(true)
  })

  it('does not match a bare identifier', () => {
    expect(matchAtStart(pattern, 'loadActiveWorktree ')).toBe(false)
  })

  it('tags the token support.function', () => {
    expect(FUNCTION_CALL_RULE[1]).toBe('support.function')
  })
})

describe('ALL_CAPS_CONSTANT_RULE', () => {
  const [pattern] = ALL_CAPS_CONSTANT_RULE

  it('matches SCREAMING_SNAKE_CASE constants', () => {
    expect(matchAtStart(pattern, 'FICHE_MISSION_PROPERTY_REPAIR_EXTRA_FEATURES')).toBe(true)
    expect(matchAtStart(pattern, 'SCOPES')).toBe(true)
  })

  it('does not match mixed-case identifiers (PascalCase, camelCase)', () => {
    expect(matchAtStart(pattern, 'FeatureFlags')).toBe(false)
    expect(matchAtStart(pattern, 'loadData')).toBe(false)
  })

  it('tags the token plain identifier, not a type', () => {
    expect(ALL_CAPS_CONSTANT_RULE[1]).toBe('identifier')
  })
})

describe('NAMESPACE_ACCESS_RULE', () => {
  const [pattern] = NAMESPACE_ACCESS_RULE

  it('matches a Capitalized identifier immediately followed by "."', () => {
    expect(matchAtStart(pattern, 'FeatureFlags.MISSION_PROPERTY_REPAIR')).toBe(true)
  })

  it('does not match a bare Capitalized identifier with no member access', () => {
    expect(matchAtStart(pattern, 'FeatureFlags')).toBe(false)
  })

  it('does not match a plain lowercase identifier', () => {
    expect(matchAtStart(pattern, 'featureFlags.x')).toBe(false)
  })

  it('colors namespace access the same as a function call — both read as "using an external symbol"', () => {
    expect(NAMESPACE_ACCESS_RULE[1]).toBe(FUNCTION_CALL_RULE[1])
  })
})

describe('HEURISTIC_IDENTIFIER_TOKEN_RULES', () => {
  it('orders the ALL_CAPS constant rule before the namespace-access rule', () => {
    // Why order matters: Monarch tries rules in array order and stops at the first
    // match. An ALL_CAPS constant used as `SCOPES.SOMETHING` must be classified by
    // ALL_CAPS_CONSTANT_RULE (plain identifier), not NAMESPACE_ACCESS_RULE (which
    // would also match the "Capitalized, followed later by a dot" shape and wrongly
    // color it like a function call).
    const constantIndex = HEURISTIC_IDENTIFIER_TOKEN_RULES.indexOf(ALL_CAPS_CONSTANT_RULE)
    const namespaceIndex = HEURISTIC_IDENTIFIER_TOKEN_RULES.indexOf(NAMESPACE_ACCESS_RULE)
    expect(constantIndex).toBeGreaterThanOrEqual(0)
    expect(namespaceIndex).toBeGreaterThan(constantIndex)
  })

  it('classifies a SCREAMING_SNAKE_CASE constant as identifier, not support.function, even though it also matches the namespace shape', () => {
    for (const [pattern, token] of HEURISTIC_IDENTIFIER_TOKEN_RULES) {
      if (matchAtStart(pattern, 'SCOPES.Y')) {
        expect(token).toBe('identifier')
        return
      }
    }
    throw new Error('expected some rule to match SCOPES.Y')
  })

  it('classifies a PascalCase namespace access as support.function', () => {
    for (const [pattern, token] of HEURISTIC_IDENTIFIER_TOKEN_RULES) {
      if (matchAtStart(pattern, 'FeatureFlags.X')) {
        expect(token).toBe('support.function')
        return
      }
    }
    throw new Error('expected some rule to match FeatureFlags.X')
  })
})
