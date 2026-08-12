import { describe, expect, it } from 'vitest'
import {
  IMPORT_CLAUSE_STATE,
  IMPORT_CLAUSE_STATE_NAME,
  IMPORT_KEYWORD_ENTER_RULE
} from './import-clause-token-rules'

function matchAtStart(pattern: RegExp, input: string): RegExpExecArray | null {
  const match = pattern.exec(input)
  return match !== null && match.index === 0 ? match : null
}

describe('IMPORT_KEYWORD_ENTER_RULE', () => {
  const [pattern, action] = IMPORT_KEYWORD_ENTER_RULE

  it('matches the import keyword and transitions into the import clause state', () => {
    expect(matchAtStart(pattern, 'import React from "react"')).not.toBeNull()
    expect(action.next).toBe(`@${IMPORT_CLAUSE_STATE_NAME}`)
    expect(action.token).toBe('keyword')
  })

  it('does not match dynamic import() expressions — those have no binding clause', () => {
    expect(matchAtStart(pattern, 'import(')).toBeNull()
    expect(matchAtStart(pattern, 'import (')).toBeNull()
  })

  it('does not match an identifier that merely starts with "import"', () => {
    expect(matchAtStart(pattern, 'importantThing')).toBeNull()
  })
})

describe('IMPORT_CLAUSE_STATE', () => {
  function classify(input: string): unknown {
    for (const rule of IMPORT_CLAUSE_STATE) {
      if (Array.isArray(rule) && rule[0] instanceof RegExp) {
        const [pattern, action] = rule
        if (matchAtStart(pattern, input)) {
          return action
        }
      }
    }
    return undefined
  }

  it('colors a capitalized default import binding as a plain identifier, not a type', () => {
    expect(classify('React')).toBe('identifier')
  })

  it('colors a capitalized named import binding as a plain identifier, not a type', () => {
    expect(classify('TestWrapper')).toBe('identifier')
  })

  it('colors a lowercase named import binding as a plain identifier', () => {
    expect(classify('waitForPageStable')).toBe('identifier')
  })

  it('exits the state on "from" and colors it as a keyword', () => {
    const action = classify('from')
    expect(action).toEqual({ token: 'keyword', next: '@pop' })
  })

  it('recognizes "as" and "type" as keywords inside the clause (renamed/type-only imports)', () => {
    expect(classify('as')).toBe('keyword')
    expect(classify('type')).toBe('keyword')
  })

  it('bails out on a string without consuming, for side-effect-only imports', () => {
    const action = classify('"./styles.css"')
    expect(action).toEqual({ token: '', next: '@pop' })
  })
})
