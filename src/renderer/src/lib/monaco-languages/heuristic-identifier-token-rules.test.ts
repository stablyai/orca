import { describe, expect, it } from 'vitest'
import {
  ALL_CAPS_CONSTANT_RULE,
  FUNCTION_CALL_RULE,
  HEURISTIC_IDENTIFIER_TOKEN_RULES,
  NAMESPACE_ACCESS_RULE
} from './heuristic-identifier-token-rules'
import { matchMonarchRuleAtStart } from './monarch-rule-test-helpers'

describe('FUNCTION_CALL_RULE', () => {
  const [pattern] = FUNCTION_CALL_RULE

  it('matches an identifier immediately followed by "("', () => {
    expect(matchMonarchRuleAtStart(pattern, 'loadActiveWorktree(')).not.toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'loadActiveWorktree (')).not.toBeNull()
  })

  it('does not match a bare identifier', () => {
    expect(matchMonarchRuleAtStart(pattern, 'loadActiveWorktree ')).toBeNull()
  })

  it('tags the token support.function', () => {
    expect(FUNCTION_CALL_RULE[1]).toBe('support.function')
  })
})

describe('ALL_CAPS_CONSTANT_RULE', () => {
  const [pattern] = ALL_CAPS_CONSTANT_RULE

  it('matches SCREAMING_SNAKE_CASE constants', () => {
    expect(
      matchMonarchRuleAtStart(pattern, 'FICHE_MISSION_PROPERTY_REPAIR_EXTRA_FEATURES')
    ).not.toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'SCOPES')).not.toBeNull()
  })

  it('does not match mixed-case identifiers (PascalCase, camelCase)', () => {
    expect(matchMonarchRuleAtStart(pattern, 'FeatureFlags')).toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'loadData')).toBeNull()
  })

  it('tags the token plain identifier, not a type', () => {
    expect(ALL_CAPS_CONSTANT_RULE[1]).toBe('identifier')
  })
})

describe('NAMESPACE_ACCESS_RULE', () => {
  const [pattern] = NAMESPACE_ACCESS_RULE

  it('matches a Capitalized identifier immediately followed by "."', () => {
    expect(matchMonarchRuleAtStart(pattern, 'FeatureFlags.MISSION_PROPERTY_REPAIR')).not.toBeNull()
  })

  it('does not match a bare Capitalized identifier with no member access', () => {
    expect(matchMonarchRuleAtStart(pattern, 'FeatureFlags')).toBeNull()
  })

  it('does not match a plain lowercase identifier', () => {
    expect(matchMonarchRuleAtStart(pattern, 'featureFlags.x')).toBeNull()
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
      if (matchMonarchRuleAtStart(pattern, 'SCOPES.Y')) {
        expect(token).toBe('identifier')
        return
      }
    }
    throw new Error('expected some rule to match SCOPES.Y')
  })

  it('classifies a PascalCase namespace access as support.function', () => {
    for (const [pattern, token] of HEURISTIC_IDENTIFIER_TOKEN_RULES) {
      if (matchMonarchRuleAtStart(pattern, 'FeatureFlags.X')) {
        expect(token).toBe('support.function')
        return
      }
    }
    throw new Error('expected some rule to match FeatureFlags.X')
  })
})
