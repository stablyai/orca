import { describe, expect, it } from 'vitest'
import {
  CARD_TEMPLATE_LIMITS,
  type CardTemplate,
  type CardTemplateNode
} from '../../../../../../shared/workspace-cards/card-template-schema'
import { CARD_PRIMITIVES } from './card-primitives'
import {
  cardElement,
  CardTemplateCompileError,
  compileCardTemplate
} from './card-template-compiler'

const registry = {
  ...CARD_PRIMITIVES,
  Echo: cardElement<string>(['text'], (props, _children, context) => (
    <i>{`${String(props.text)}${context}`}</i>
  ))
}

function template(root: CardTemplate['root'], extra: Partial<CardTemplate> = {}): CardTemplate {
  return { version: 1, facts: 1, root, ...extra }
}

describe('card template compiler', () => {
  it('bounds the tree defs expand to', () => {
    // Each def holds `width` copies of the next: tiny as written, width^levels once inlined.
    const fanOut = (levels: number, width: number): CardTemplate => {
      const defs: Record<string, CardTemplateNode> = {}
      for (let i = 0; i < levels; i++) {
        defs[`D${i}`] = {
          el: 'Row',
          children: Array.from({ length: width }, () => ({ el: `D${i + 1}` }))
        }
      }
      defs[`D${levels}`] = { el: 'Echo', props: { text: 'x' } }
      return template({ el: 'D0' }, { defs })
    }
    expect(() => compileCardTemplate(fanOut(3, 2), registry)).not.toThrow()
    expect(() => compileCardTemplate(fanOut(7, 20), registry)).toThrow(/more than .* elements/)

    const chain = (levels: number): CardTemplate => {
      const defs: Record<string, CardTemplateNode> = {}
      for (let i = 0; i < levels; i++) {
        defs[`D${i}`] = { el: 'Row', children: [{ el: `D${i + 1}` }] }
      }
      defs[`D${levels}`] = { el: 'Row' }
      return template({ el: 'D0' }, { defs })
    }
    expect(() =>
      compileCardTemplate(chain(CARD_TEMPLATE_LIMITS.maxDefDepth - 1), registry)
    ).not.toThrow()
    expect(() => compileCardTemplate(chain(CARD_TEMPLATE_LIMITS.maxDefDepth), registry)).toThrow(
      /defs nested deeper/
    )

    // Each def is shallow, but inlined they nest past maxDepth.
    const deep: Record<string, CardTemplateNode> = {}
    let leaf: CardTemplateNode = { el: 'Row' }
    for (let i = 0; i < 20; i++) {
      leaf = { el: 'Row', children: [leaf] }
    }
    deep.Inner = leaf
    deep.Outer = {
      el: 'Row',
      children: [
        {
          el: 'Row',
          children: [{ el: 'Row', children: [{ el: 'Row', children: [{ el: 'Inner' }] }] }]
        }
      ]
    }
    expect(() => compileCardTemplate(template({ el: 'Outer' }, { defs: deep }), registry)).toThrow(
      /nested deeper than/
    )
  })

  it('refuses unknown elements and props, recursive defs and bad expressions', () => {
    const cases: CardTemplate[] = [
      template({ el: 'Script' }),
      template({ el: 'Echo', props: { onClick: 'x' } }),
      template({ el: 'Loop' }, { defs: { Loop: { el: 'Row', children: [{ el: 'Loop' }] } } }),
      template(
        { el: 'A' },
        { defs: { A: { el: 'Row', children: [{ el: 'B' }] }, B: { el: 'A' } } }
      ),
      template({ el: 'Label', props: { text: 'x' } }, { defs: { Label: { el: 'Echo' } } }),
      template({ el: 'Label', children: [{ el: 'Row' }] }, { defs: { Label: { el: 'Row' } } }),
      template({ el: 'Echo', props: { text: '=ws.name(' } })
    ]
    for (const bad of cases) {
      expect(() => compileCardTemplate(bad, registry)).toThrow(CardTemplateCompileError)
    }
  })
})
