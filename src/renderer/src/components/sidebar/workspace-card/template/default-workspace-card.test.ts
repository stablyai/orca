import React from 'react'
import { describe, expect, it } from 'vitest'
import type { CardTemplateNode } from '../../../../../../shared/workspace-cards/card-template-schema'
import { compileCardTemplate, type CardElementRegistry } from './card-template-compiler'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from './default-workspace-card'

type Drawn = { el: string; props: Readonly<Record<string, unknown>>; children: unknown[] }

// Every element the template names draws as a marker element, so the test reads the tree it lays out.
function recordingRegistry(): CardElementRegistry<null> {
  const props = new Map<string, Set<string>>()
  const visit = (node: CardTemplateNode): void => {
    const names = props.get(node.el) ?? new Set<string>()
    Object.keys(node.props ?? {}).forEach((name) => names.add(name))
    props.set(node.el, names)
    node.children?.forEach(visit)
  }
  Object.values(DEFAULT_WORKSPACE_CARD_TEMPLATE.defs ?? {}).forEach(visit)
  visit(DEFAULT_WORKSPACE_CARD_TEMPLATE.root)
  return Object.fromEntries(
    [...props].map(([el, names]) => [
      el,
      {
        kind: 'inline' as const,
        props: [...names],
        render: (resolved: Readonly<Record<string, unknown>>, children: React.ReactNode[]) =>
          React.createElement('drawn-element', { el, drawnProps: resolved }, ...children)
      }
    ])
  )
}

type DrawnElementProps = {
  el: string
  drawnProps: Readonly<Record<string, unknown>>
  children?: React.ReactNode
}

function isDrawn(node: unknown): node is React.ReactElement<DrawnElementProps> {
  return React.isValidElement<DrawnElementProps>(node) && node.type === 'drawn-element'
}

/** Each drawn element with the elements it sits inside. */
function flatten(node: unknown, ancestors: Drawn[] = []): { node: Drawn; ancestors: Drawn[] }[] {
  if (!isDrawn(node)) {
    return []
  }
  const drawn: Drawn = {
    el: node.props.el,
    props: node.props.drawnProps,
    children: React.Children.toArray(node.props.children)
  }
  return [
    { node: drawn, ancestors },
    ...drawn.children.flatMap((child) => flatten(child, [...ancestors, drawn]))
  ]
}

const opensHoverCard = (node: Drawn): boolean =>
  node.el === 'DetailsHover' || (node.el === 'Indicators' && node.props.hover === 'meta')

const compiled = compileCardTemplate(DEFAULT_WORKSPACE_CARD_TEMPLATE, recordingRegistry())
const allShown = Object.fromEntries(
  ['status', 'branch', 'issue', 'linearIssue', 'jiraIssue', 'pr', 'comment', 'ports'].map((key) => [
    key,
    true
  ])
)

describe('default workspace card', () => {
  // The auto-name error lives in the row's hover card, so its mark must sit inside that card's trigger,
  // and a row has one hover card, never two sharing one open state.
  it('puts a failed auto-name inside the one row hover card for every style', () => {
    for (const style of ['classic', 'compact', 'new']) {
      for (const linkCount of [0, 2]) {
        for (const hasRenameError of [false, true]) {
          const facts = {
            ws: { title: 'taniwha', name: 'taniwha', branch: 'b', identity: 'b', hasRenameError },
            options: { style, show: allShown, detailsRow: true },
            links: { count: linkCount },
            ports: { count: 0 },
            place: {},
            host: { kind: 'local' }
          }
          const drawn = flatten(compiled.render(facts, null).content)
          const where = `${style}, ${linkCount} links, error ${hasRenameError}`
          expect(
            drawn.filter(({ node }) => opensHoverCard(node)).length,
            where
          ).toBeLessThanOrEqual(1)
          const mark = drawn.find(({ node }) => node.el === 'RenameError')
          expect(Boolean(mark), where).toBe(hasRenameError)
          if (mark) {
            expect(
              mark.ancestors.some((node) => node.el === 'DetailsHover'),
              where
            ).toBe(true)
          }
        }
      }
    }
  })
})
