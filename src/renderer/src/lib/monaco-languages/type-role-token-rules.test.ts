import { describe, expect, it } from 'vitest'
import {
  LITERAL_CONSTANT_RULE,
  PRIMITIVE_TYPE_RULE,
  TYPE_DECLARATION_RULE
} from './type-role-token-rules'
import { matchMonarchRuleAtStart } from './monarch-rule-test-helpers'

describe('PRIMITIVE_TYPE_RULE', () => {
  const [pattern, token] = PRIMITIVE_TYPE_RULE

  it('tags primitive type annotations with the type color', () => {
    expect(token).toBe('type')
    expect(matchMonarchRuleAtStart(pattern, 'string;')).not.toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'number | null')).not.toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'boolean>')).not.toBeNull()
  })

  it('leaves longer identifiers, calls and member access alone', () => {
    expect(matchMonarchRuleAtStart(pattern, 'stringify(')).toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'string()')).toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'symbol.description')).toBeNull()
  })
})

describe('LITERAL_CONSTANT_RULE', () => {
  const [pattern, token] = LITERAL_CONSTANT_RULE

  it('tags null, undefined and booleans as language constants', () => {
    expect(token).toBe('constant.language')
    for (const literal of ['null;', 'undefined;', 'true,', 'false)']) {
      expect(matchMonarchRuleAtStart(pattern, literal), literal).not.toBeNull()
    }
  })

  it('does not match identifiers that merely start with a literal', () => {
    expect(matchMonarchRuleAtStart(pattern, 'nullable')).toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'trueValue')).toBeNull()
  })
})

describe('TYPE_DECLARATION_RULE', () => {
  const [pattern, tokens] = TYPE_DECLARATION_RULE

  it('tags the declared name of classes, interfaces, enums and type aliases', () => {
    expect(tokens).toEqual(['keyword', '', 'type.declaration'])
    expect(
      matchMonarchRuleAtStart(pattern, 'class AccountingLinesRepository implements')?.[3]
    ).toBe('AccountingLinesRepository')
    expect(matchMonarchRuleAtStart(pattern, 'interface Worktree {')?.[3]).toBe('Worktree')
    expect(matchMonarchRuleAtStart(pattern, 'enum Status {')?.[3]).toBe('Status')
    expect(matchMonarchRuleAtStart(pattern, 'type Id = string')?.[3]).toBe('Id')
    expect(matchMonarchRuleAtStart(pattern, 'class API {')?.[3]).toBe('API')
  })

  it('does not treat anonymous class heritage or non-declarations as a name', () => {
    expect(matchMonarchRuleAtStart(pattern, 'class extends Base {')).toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'type: string')).toBeNull()
    expect(matchMonarchRuleAtStart(pattern, 'typeof value')).toBeNull()
  })
})
