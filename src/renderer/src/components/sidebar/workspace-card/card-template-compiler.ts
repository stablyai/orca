import React from 'react'
import type { CardExpressionScope } from '../../../../../shared/workspace-cards/card-expression'
import type { CardTemplate } from '../../../../../shared/workspace-cards/card-template-schema'
import {
  CardTemplateCompileError,
  expandCardTemplate,
  type ExpandedCardNode
} from '../../../../../shared/workspace-cards/card-template-expansion'

/** A layout primitive drawn as a host element. */
export type CardHostElement = {
  kind: 'host'
  props: readonly string[]
  resolve: (props: Readonly<Record<string, unknown>>) => {
    tag: string
    attrs: Record<string, unknown>
  }
}

/** An element drawn by a function, not a component, so a part adds no layer of its own.
 *  Template values arrive unchecked, so `render` coerces every prop it reads.
 *  `render` must not call hooks: `when` toggles it, so anything stateful must be a component element. */
export type CardInlineElement<Context> = {
  kind: 'inline'
  props: readonly string[]
  render: (
    props: Readonly<Record<string, unknown>>,
    children: React.ReactNode[],
    context: Context
  ) => React.ReactNode
}

export type CardElement<Context> = CardHostElement | CardInlineElement<Context>
export type CardElementRegistry<Context> = Readonly<Record<string, CardElement<Context>>>

export function cardElement<Context>(
  props: readonly string[],
  render: CardInlineElement<Context>['render']
): CardInlineElement<Context> {
  return { kind: 'inline', props, render }
}

export type CardFrame = { singleLine: boolean; statusLane: boolean }

export type CompiledCardTemplate<Context> = {
  /** `context` reaches parts only; `rootAttrs` lets the frame style the root from the
   *  template's own frame answers. */
  render: (
    facts: CardExpressionScope,
    context: Context,
    rootAttrs?: (frame: CardFrame) => Readonly<Record<string, unknown>> | undefined
  ) => { content: React.ReactNode; frame: CardFrame }
}

export { CardTemplateCompileError }

type CompiledNode<Context> = (
  scope: CardExpressionScope,
  context: Context,
  key: number,
  rootAttrs?: Readonly<Record<string, unknown>>
) => React.ReactNode

function compileNode<Context>(
  node: ExpandedCardNode,
  registry: CardElementRegistry<Context>
): CompiledNode<Context> {
  // Expansion already refused unknown elements, so this lookup always finds one.
  const element = registry[node.el]
  if (!element) {
    throw new CardTemplateCompileError(`unknown element ${node.el}`, node.path)
  }
  const { when, props } = node
  const children = node.children.map((child) => compileNode(child, registry))
  const renderChildren = (scope: CardExpressionScope, context: Context): React.ReactNode[] =>
    children.map((child, index) => child(scope, context, index))
  const resolveProps = (scope: CardExpressionScope): Record<string, unknown> => {
    const resolved: Record<string, unknown> = {}
    for (const prop of props) {
      resolved[prop.name] = prop.value(scope)
    }
    return resolved
  }

  if (element.kind === 'host') {
    // Why precompute: most layout props are literals, so their class names never change.
    const staticHost = node.literalProps ? element.resolve(node.literalProps) : null
    return (scope, context, key, rootAttrs) => {
      if (when && !when(scope)) {
        return null
      }
      const host = staticHost ?? element.resolve(resolveProps(scope))
      return React.createElement(
        host.tag,
        rootAttrs ? { ...host.attrs, ...rootAttrs, key } : { ...host.attrs, key },
        ...renderChildren(scope, context)
      )
    }
  }
  const render = element.render
  return (scope, context) => {
    if (when && !when(scope)) {
      return null
    }
    return render(resolveProps(scope), renderChildren(scope, context), context)
  }
}

/** Compile once per template; `render` then only evaluates expressions over one card's facts. */
export function compileCardTemplate<Context>(
  template: CardTemplate,
  registry: CardElementRegistry<Context>
): CompiledCardTemplate<Context> {
  const expanded = expandCardTemplate(template, (el) =>
    Object.hasOwn(registry, el) ? registry[el]?.props : undefined
  )
  const root = compileNode(expanded.root, registry)
  const { vars, frame: flags } = expanded
  return {
    render: (facts, context, rootAttrs) => {
      const values: Record<string, unknown> = {}
      const scope: CardExpressionScope = { ...facts, vars: values }
      for (const [name, evaluate] of vars) {
        values[name] = evaluate(scope)
      }
      const frame = {
        singleLine: Boolean(flags.singleLine(scope)),
        statusLane: Boolean(flags.statusLane(scope))
      }
      return { content: root(scope, context, 0, rootAttrs?.(frame)), frame }
    }
  }
}
