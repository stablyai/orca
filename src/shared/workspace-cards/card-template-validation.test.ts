import { describe, expect, it } from 'vitest'
import defaultCard from '../../renderer/src/components/sidebar/workspace-card/default-workspace-card.json'
import { cardTemplateSchema, type CardTemplate } from './card-template-schema'
import { cardTemplateIssues } from './card-template-validation'

const base: CardTemplate = { version: 1, facts: 1, root: { el: 'Row' } }

describe('card template validation', () => {
  it("accepts Orca's own card", () => {
    expect(cardTemplateIssues(cardTemplateSchema.parse(defaultCard))).toEqual([])
  })

  it('names every problem with its path', () => {
    const issues = cardTemplateIssues({
      ...base,
      vars: { broken: 'ws.name(' },
      defs: { Loop: { el: 'Row', children: [{ el: 'Loop' }] } },
      root: {
        el: 'Row',
        when: '1 +',
        children: [{ el: 'Script' }, { el: 'Text', props: { onClick: 'x', text: '=a[' } }]
      }
    })
    expect(issues).toEqual([
      expect.stringMatching(/^vars\.broken: /),
      'defs.Loop: uses itself',
      expect.stringMatching(/^root\.when: /),
      'root.children[0]: unknown element Script',
      'root.children[1].props: Text has no prop onClick',
      expect.stringMatching(/^root\.children\[1\]\.props\.text: /)
    ])
  })
})
