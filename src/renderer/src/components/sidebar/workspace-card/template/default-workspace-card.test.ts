import { describe, expect, it } from 'vitest'
import { compileCardExpression } from '../../../../../../shared/workspace-cards/card-expression'
import defaultCardJson from './default-workspace-card.json'

// Evaluates the template's vars in order, as the renderer does, so later vars can read earlier ones.
function evaluateVars(facts: Record<string, unknown>): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const [name, source] of Object.entries(defaultCardJson.vars)) {
    vars[name] = compileCardExpression(source).evaluate({ ...facts, vars })
  }
  return vars
}

function compactCardFacts(compactHover: boolean): Record<string, unknown> {
  return {
    ws: { title: 'Fix login', branch: 'fix/login', name: 'fix-login', kind: 'git' },
    links: { count: 1 },
    ports: { count: 0 },
    options: { style: 'compact', show: {}, compactHover }
  }
}

describe('default workspace card hover details', () => {
  it('follows the compact hover setting', () => {
    expect(evaluateVars(compactCardFacts(true)).hoverDetails).toBe(true)
    expect(evaluateVars(compactCardFacts(false)).hoverDetails).toBe(false)
  })

  it('keeps the hover for the new card style when the compact hover is off', () => {
    const facts = compactCardFacts(false)
    facts.options = { style: 'new', show: {}, compactHover: false }
    expect(evaluateVars(facts).hoverDetails).toBe(true)
  })
})
