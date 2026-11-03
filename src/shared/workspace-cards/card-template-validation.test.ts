import { describe, expect, it } from 'vitest'
import defaultCard from '../../renderer/src/components/sidebar/workspace-card/default-workspace-card.json'
import { cardTemplateSchema, type CardTemplate } from './card-template-schema'
import { cardTemplateIssues } from './card-template-validation'

const base: CardTemplate = { version: 1, facts: 1, root: { el: 'Row' } }

describe('card template validation', () => {
  it("accepts Orca's own card", () => {
    expect(cardTemplateIssues(cardTemplateSchema.parse(defaultCard))).toEqual([])
  })

  it('refuses what the renderer refuses, naming the path', () => {
    const cases: [CardTemplate, RegExp][] = [
      [{ ...base, vars: { broken: 'ws.name(' } }, /^vars\.broken: /],
      [
        {
          ...base,
          defs: { Loop: { el: 'Row', children: [{ el: 'Loop' }] } },
          root: { el: 'Loop' }
        },
        /uses itself/
      ],
      [
        { ...base, root: { el: 'Row', children: [{ el: 'Script' }] } },
        /^root\.children\[0\]: unknown element Script/
      ],
      [
        { ...base, root: { el: 'Text', props: { onClick: 'x' } } },
        /^root\.props: Text has no prop onClick/
      ],
      [
        { ...base, defs: { A: { el: 'Row' } }, root: { el: 'A', props: { gap: 'sm' } } },
        /takes no props or children/
      ]
    ]
    for (const [template, issue] of cases) {
      expect(cardTemplateIssues(template)).toEqual([expect.stringMatching(issue)])
    }
  })

  it('caps how far defs expand, as the renderer does', () => {
    // Each level doubles the tree: 2^12 elements is past the expansion cap.
    const defs: CardTemplate['defs'] = { L0: { el: 'Text' } }
    for (let level = 1; level <= 12; level++) {
      defs[`L${level}`] = {
        el: 'Row',
        children: [{ el: `L${level - 1}` }, { el: `L${level - 1}` }]
      }
    }
    expect(cardTemplateIssues({ ...base, defs, root: { el: 'L12' } })).toEqual([
      expect.stringMatching(/defs nested deeper|expands to more than/)
    ])
  })
})
