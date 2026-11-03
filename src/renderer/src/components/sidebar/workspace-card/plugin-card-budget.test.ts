import { describe, expect, it } from 'vitest'
import { CARD_ELEMENT_PROPS } from '../../../../../shared/workspace-cards/card-element-catalog'
import {
  CardEvaluationBudgetExceeded,
  withCardEvaluationBudget
} from '../../../../../shared/workspace-cards/card-expression'
import {
  CARD_TEMPLATE_LIMITS,
  PLUGIN_CARD_TEMPLATE_LIMITS,
  type CardTemplate,
  type CardTemplateNode
} from '../../../../../shared/workspace-cards/card-template-schema'
import { cardTemplateIssues } from '../../../../../shared/workspace-cards/card-template-validation'
import { CARD_PRIMITIVES } from './card-primitives'
import { cardElement, compileCardTemplate } from './card-template-compiler'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from './default-workspace-card'

// Parts drawn as nothing: what is measured here is template evaluation, not Orca's components.
const registry = {
  ...Object.fromEntries(
    Object.entries(CARD_ELEMENT_PROPS).map(([name, props]) => [
      name,
      cardElement<null>(props, () => null)
    ])
  ),
  ...CARD_PRIMITIVES
}

const facts = {
  ws: {
    name: 'card-plugins',
    title: 'card-plugins',
    branch: 'feature/x',
    kind: 'git',
    path: '/w',
    comment: ''
  },
  repo: { name: 'orca', ssh: false },
  host: { kind: 'local', contextLabel: null },
  git: { conflictOperation: null, remoteBranchConflict: null, cacheTimerActive: false },
  links: { count: 1, issue: true },
  ports: { count: 0 },
  lineage: { toggleable: false },
  place: { inPinnedSection: false },
  options: { style: 'classic', show: { status: true, host: true, inlineAgents: true, pr: true } },
  provenance: {}
}

function stepsFor(template: CardTemplate): number {
  const compiled = compileCardTemplate(template, registry)
  let low = 0
  let high = 1_000_000
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    try {
      withCardEvaluationBudget(mid, () => compiled.render(facts, null))
      high = mid
    } catch (error) {
      if (!(error instanceof CardEvaluationBudgetExceeded)) {
        throw error
      }
      low = mid + 1
    }
  }
  return low
}

/** The heaviest plugin template the caps admit: every expanded element at the node cap, each
 *  prop a long expression. */
function worstCaseTemplate(): CardTemplate {
  const heavy = `=${Array.from({ length: 40 }, () => 'lower(ws.name + ws.branch)').join(' + ')}`
  const text: CardTemplateNode = { el: 'Text', props: { text: heavy, size: heavy, tone: heavy } }
  const row: CardTemplateNode = {
    el: 'Row',
    children: Array.from({ length: 9 }, () => ({ el: 'Leaf' }))
  }
  return {
    version: 1,
    facts: 1,
    defs: { Leaf: text, Line: row },
    root: { el: 'Stack', children: Array.from({ length: 19 }, () => ({ el: 'Line' })) }
  }
}

describe('plugin card budget', () => {
  it("leaves Orca's own card well inside the step budget", () => {
    expect(stepsFor(DEFAULT_WORKSPACE_CARD_TEMPLATE) * 4).toBeLessThan(
      PLUGIN_CARD_TEMPLATE_LIMITS.maxEvaluationSteps
    )
  })

  it('caps plugin templates far below Orca-internal templates', () => {
    expect(PLUGIN_CARD_TEMPLATE_LIMITS.maxExpandedNodes).toBeLessThan(
      CARD_TEMPLATE_LIMITS.maxExpandedNodes / 5
    )
    const oversized: CardTemplate = {
      ...worstCaseTemplate(),
      root: { el: 'Stack', children: Array.from({ length: 30 }, () => ({ el: 'Line' })) }
    }
    expect(cardTemplateIssues(oversized)).toEqual([
      expect.stringMatching(/expands to more than 200/)
    ])
  })

  it('draws 300 cards of the worst valid plugin template inside the budget', () => {
    const template = worstCaseTemplate()
    expect(cardTemplateIssues(template)).toEqual([])
    const compiled = compileCardTemplate(template, registry, PLUGIN_CARD_TEMPLATE_LIMITS)
    const start = performance.now()
    let fellBack = 0
    for (let card = 0; card < 300; card++) {
      try {
        withCardEvaluationBudget(PLUGIN_CARD_TEMPLATE_LIMITS.maxEvaluationSteps, () =>
          compiled.render(facts, null)
        )
      } catch (error) {
        expect(error).toBeInstanceOf(CardEvaluationBudgetExceeded)
        fellBack++
      }
    }
    const elapsed = performance.now() - start
    // Every heavy card stops at the step budget, so 300 of them stay well under a second.
    expect(fellBack).toBe(300)
    expect(elapsed).toBeLessThan(500)
  })
})
