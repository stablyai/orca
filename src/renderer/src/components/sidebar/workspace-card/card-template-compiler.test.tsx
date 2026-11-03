import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CardTemplate } from '../../../../../shared/workspace-cards/card-template-schema'
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

function draw(t: CardTemplate, facts: Record<string, unknown> = {}): string {
  const { content } = compileCardTemplate(t, registry).render(facts, '')
  return renderToStaticMarkup(<>{content}</>)
}

describe('card template compiler', () => {
  it('draws layout as host elements and evaluates props, vars and when', () => {
    const t = template(
      {
        el: 'Row',
        props: { gap: 'sm', align: '=vars.wide ? "center" : "start"' },
        children: [
          { el: 'Echo', props: { text: '=ws.name' } },
          { el: 'Echo', when: 'ws.hidden', props: { text: 'never' } }
        ]
      },
      { vars: { wide: 'len(ws.name) > 3' } }
    )
    expect(draw(t, { ws: { name: 'card plugins', hidden: false } })).toBe(
      '<div class="flex min-w-0 gap-1 items-center"><i>card plugins</i></div>'
    )
    expect(draw(t, { ws: { name: 'abc' } })).toContain('items-start')
  })

  it('expands defs and reports frame answers', () => {
    const t = template(
      { el: 'Stack', children: [{ el: 'Label' }, { el: 'Label', when: 'false' }] },
      {
        defs: { Label: { el: 'Echo', props: { text: 'hi' } } },
        frame: { singleLine: '=true', statusLane: false }
      }
    )
    const compiled = compileCardTemplate(t, registry)
    const { frame, content } = compiled.render({}, '!')
    expect(frame).toEqual({ singleLine: true, statusLane: false })
    expect(renderToStaticMarkup(<>{content}</>)).toBe(
      '<div class="flex min-w-0 flex-col"><i>hi!</i></div>'
    )
  })

  it('lets the frame add attributes to the root', () => {
    const { content } = compileCardTemplate(template({ el: 'Row' }), registry).render(
      {},
      '',
      () => ({
        style: { marginLeft: '-4px' }
      })
    )
    expect(renderToStaticMarkup(<>{content}</>)).toContain('margin-left:-4px')
  })

  it('collects the fact domains a template reads', () => {
    const t = template(
      {
        el: 'Row',
        when: 'place.isActive',
        children: [{ el: 'Echo', props: { text: '=review.title' } }]
      },
      { vars: { x: 'ws.name' } }
    )
    expect([...compileCardTemplate(t, registry).roots].sort()).toEqual(['place', 'review', 'ws'])
  })

  it('refuses unknown elements and props, recursive defs and bad expressions', () => {
    const cases: CardTemplate[] = [
      template({ el: 'Script' }),
      template({ el: 'Echo', props: { onClick: 'x' } }),
      template({ el: 'Loop' }, { defs: { Loop: { el: 'Row', children: [{ el: 'Loop' }] } } }),
      template({ el: 'Echo', props: { text: '=ws.name(' } })
    ]
    for (const bad of cases) {
      expect(() => compileCardTemplate(bad, registry)).toThrow(CardTemplateCompileError)
    }
  })
})
