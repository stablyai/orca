import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CARD_TEMPLATE_LIMITS,
  type CardTemplate,
  type CardTemplateNode
} from '../../../../../shared/workspace-cards/card-template-schema'
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
          { el: 'Echo', when: 'ws.isPinned', props: { text: 'never' } }
        ]
      },
      { vars: { wide: 'len(ws.name) > 3' } }
    )
    expect(draw(t, { ws: { name: 'card plugins', isPinned: false } })).toBe(
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

  it('passes frame attributes through a def used as the root, and honours its when', () => {
    const t = template({ el: 'Body', when: 'ws.isPinned' }, { defs: { Body: { el: 'Row' } } })
    const compiled = compileCardTemplate(t, registry)
    const attrs = (): Record<string, unknown> => ({ style: { marginLeft: '-4px' } })
    const shown = compiled.render({ ws: { isPinned: true } }, '', attrs).content
    expect(renderToStaticMarkup(<>{shown}</>)).toContain('margin-left:-4px')
    expect(compiled.render({ ws: { isPinned: false } }, '', attrs).content).toBeNull()
  })

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

describe('card template compiler: facts, lists and strings', () => {
  it('refuses a fact the model does not have, instead of drawing nothing', () => {
    expect(() =>
      compileCardTemplate(template({ el: 'Echo', when: 'ws.brnach' }), registry)
    ).toThrow(/unknown fact ws\.brnach/)
  })

  it('draws Each once per agent, reading item.*', () => {
    const t = template({
      el: 'Row',
      children: [
        {
          el: 'Each',
          props: { items: '=activity.agents', limit: 2 },
          children: [{ el: 'Echo', props: { text: "=item.title + ':' + item.state" } }]
        }
      ]
    })
    const facts = {
      activity: {
        agents: [
          { title: 'Claude', state: 'working' },
          { title: 'Codex', state: 'blocked' },
          { title: 'Third', state: 'done' }
        ]
      }
    }
    expect(draw(t, facts)).toBe(
      '<div class="flex min-w-0"><i>Claude:working</i><i>Codex:blocked</i></div>'
    )
    expect(() =>
      compileCardTemplate(
        template({ el: 'Each', props: { items: '=ws.name' }, children: [] }),
        registry
      )
    ).toThrow(/Each needs items naming a list fact/)
    expect(() =>
      compileCardTemplate(template({ el: 'Echo', props: { text: '=item.title' } }), registry)
    ).toThrow(/unknown fact item\.title/)
  })

  it("reads the template's own strings in the person's language, falling back to en", () => {
    const t = template(
      { el: 'Echo', props: { text: "=t('none')" } },
      { strings: { en: { none: 'No pull request' }, fr: { none: 'Aucune pull request' } } }
    )
    const drawIn = (locale: string) => {
      const { content } = compileCardTemplate(t, registry, { locale }).render({}, '')
      return renderToStaticMarkup(<>{content}</>)
    }
    expect(drawIn('fr-FR')).toBe('<i>Aucune pull request</i>')
    expect(drawIn('de')).toBe('<i>No pull request</i>')
  })
})
