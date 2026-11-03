import React from 'react'
import {
  compileCardExpression,
  type CardExpressionScope,
  type CardExpressionValue
} from '../../../../../shared/workspace-cards/card-expression'
import {
  CARD_TEMPLATE_LIMITS,
  isCardExpression,
  type CardPropValue,
  type CardTemplate,
  type CardTemplateNode
} from '../../../../../shared/workspace-cards/card-template-schema'

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

export class CardTemplateCompileError extends Error {
  constructor(message: string, path: string) {
    super(`${path}: ${message}`)
    this.name = 'CardTemplateCompileError'
  }
}

type CompiledNode<Context> = (
  scope: CardExpressionScope,
  context: Context,
  key: number,
  rootAttrs?: Readonly<Record<string, unknown>>
) => React.ReactNode

class Compiler<Context> {
  private readonly expanding = new Set<string>()
  private expandedNodes = 0

  constructor(
    private readonly registry: CardElementRegistry<Context>,
    private readonly defs: Readonly<Record<string, CardTemplateNode>>
  ) {}

  value(value: CardPropValue, path: string): CardExpressionValue {
    if (!isCardExpression(value)) {
      return () => value
    }
    return this.expression(value.slice(1), path)
  }

  expression(source: string, path: string): CardExpressionValue {
    try {
      return compileCardExpression(source).evaluate
    } catch (error) {
      throw new CardTemplateCompileError(
        error instanceof Error ? error.message : String(error),
        path
      )
    }
  }

  /** `depth` is the node's depth in the expanded tree, since each def reference inlines a copy. */
  node(node: CardTemplateNode, path: string, depth = 1): CompiledNode<Context> {
    const when = node.when === undefined ? null : this.expression(node.when, `${path}.when`)
    const def = Object.hasOwn(this.defs, node.el) ? this.defs[node.el] : undefined
    if (def) {
      if (node.props !== undefined || node.children !== undefined) {
        throw new CardTemplateCompileError(
          `${node.el} is a def and takes no props or children`,
          path
        )
      }
      if (this.expanding.has(node.el)) {
        throw new CardTemplateCompileError(`${node.el} uses itself`, path)
      }
      if (this.expanding.size >= CARD_TEMPLATE_LIMITS.maxDefDepth) {
        throw new CardTemplateCompileError(
          `defs nested deeper than ${CARD_TEMPLATE_LIMITS.maxDefDepth}`,
          path
        )
      }
      this.expanding.add(node.el)
      const inner = this.node(def, `defs.${node.el}`, depth)
      this.expanding.delete(node.el)
      if (!when) {
        return inner
      }
      return (scope, context, key, rootAttrs) =>
        when(scope) ? inner(scope, context, key, rootAttrs) : null
    }
    // Why count expanded nodes: defs reused at each level multiply, so the schema's own count is no bound.
    if (++this.expandedNodes > CARD_TEMPLATE_LIMITS.maxExpandedNodes) {
      throw new CardTemplateCompileError(
        `expands to more than ${CARD_TEMPLATE_LIMITS.maxExpandedNodes} elements`,
        path
      )
    }
    if (depth > CARD_TEMPLATE_LIMITS.maxDepth) {
      throw new CardTemplateCompileError(
        `nested deeper than ${CARD_TEMPLATE_LIMITS.maxDepth}`,
        path
      )
    }
    const element = Object.hasOwn(this.registry, node.el) ? this.registry[node.el] : undefined
    if (!element) {
      throw new CardTemplateCompileError(`unknown element ${node.el}`, path)
    }
    const entries = Object.entries(node.props ?? {})
    for (const [name] of entries) {
      if (!element.props.includes(name)) {
        throw new CardTemplateCompileError(`${node.el} has no prop ${name}`, `${path}.props`)
      }
    }
    const props = entries.map(
      ([name, value]) => [name, this.value(value, `${path}.props.${name}`)] as const
    )
    const children = (node.children ?? []).map((child, index) =>
      this.node(child, `${path}.children[${index}]`, depth + 1)
    )
    const renderChildren = (scope: CardExpressionScope, context: Context): React.ReactNode[] =>
      children.map((child, index) => child(scope, context, index))
    const resolveProps = (scope: CardExpressionScope): Record<string, unknown> => {
      const resolved: Record<string, unknown> = {}
      for (const [name, evaluate] of props) {
        resolved[name] = evaluate(scope)
      }
      return resolved
    }

    if (element.kind === 'host') {
      // Why precompute: most layout props are literals, so their class names never change.
      const staticHost = entries.every(([, value]) => !isCardExpression(value))
        ? element.resolve(Object.fromEntries(entries))
        : null
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
}

function frameFlag<Context>(
  compiler: Compiler<Context>,
  value: CardPropValue | undefined,
  path: string
): CardExpressionValue {
  return value === undefined ? () => false : compiler.value(value, path)
}

/** Compile once per template; `render` then only evaluates expressions over one card's facts. */
export function compileCardTemplate<Context>(
  template: CardTemplate,
  registry: CardElementRegistry<Context>
): CompiledCardTemplate<Context> {
  const compiler = new Compiler<Context>(registry, template.defs ?? {})
  const vars = Object.entries(template.vars ?? {}).map(
    ([name, source]) => [name, compiler.expression(source, `vars.${name}`)] as const
  )
  const singleLine = frameFlag(compiler, template.frame?.singleLine, 'frame.singleLine')
  const statusLane = frameFlag(compiler, template.frame?.statusLane, 'frame.statusLane')
  const root = compiler.node(template.root, 'root')
  return {
    render: (facts, context, rootAttrs) => {
      const values: Record<string, unknown> = {}
      const scope: CardExpressionScope = { ...facts, vars: values }
      for (const [name, evaluate] of vars) {
        values[name] = evaluate(scope)
      }
      const frame = {
        singleLine: Boolean(singleLine(scope)),
        statusLane: Boolean(statusLane(scope))
      }
      return { content: root(scope, context, 0, rootAttrs?.(frame)), frame }
    }
  }
}
