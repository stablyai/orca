import React from 'react'
import {
  compileCardExpression,
  type CardExpressionScope,
  type CardExpressionValue
} from '../../../../../shared/workspace-cards/card-expression'
import {
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
 *  Template values arrive unchecked, so `render` coerces every prop it reads. */
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
  /** Fact domains the template reads, so a card can skip subscriptions it does not need. */
  roots: ReadonlySet<string>
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
  readonly roots = new Set<string>()
  private readonly expanding = new Set<string>()

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
      const compiled = compileCardExpression(source)
      for (const root of compiled.roots) {
        this.roots.add(root)
      }
      return compiled.evaluate
    } catch (error) {
      throw new CardTemplateCompileError(
        error instanceof Error ? error.message : String(error),
        path
      )
    }
  }

  node(node: CardTemplateNode, path: string): CompiledNode<Context> {
    const when = node.when === undefined ? null : this.expression(node.when, `${path}.when`)
    const def = this.defs[node.el]
    if (def) {
      if (this.expanding.has(node.el)) {
        throw new CardTemplateCompileError(`${node.el} uses itself`, path)
      }
      this.expanding.add(node.el)
      const inner = this.node(def, `defs.${node.el}`)
      this.expanding.delete(node.el)
      return (scope, key, rootAttrs) => (when && !when(scope) ? null : inner(scope, key, rootAttrs))
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
      this.node(child, `${path}.children[${index}]`)
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
  // `vars` is the template's own namespace, not a fact domain.
  compiler.roots.delete('vars')
  return {
    roots: compiler.roots,
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
