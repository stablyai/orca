import { compileCardExpression, type CardExpressionValue } from './card-expression'
import {
  CARD_TEMPLATE_LIMITS,
  isCardExpression,
  type CardPropValue,
  type CardTemplate,
  type CardTemplateNode
} from './card-template-schema'

export class CardTemplateCompileError extends Error {
  constructor(message: string, path: string) {
    super(`${path}: ${message}`)
    this.name = 'CardTemplateCompileError'
  }
}

/** A prop after expansion: a literal, or an expression already compiled. */
export type ExpandedCardProp = { name: string; literal: boolean; value: CardExpressionValue }

/** One element of the template with defs inlined, every expression compiled and every cap checked. */
export type ExpandedCardNode = {
  el: string
  path: string
  when: CardExpressionValue | null
  props: ExpandedCardProp[]
  /** Literal props only, for elements that precompute from them. */
  literalProps: Readonly<Record<string, CardPropValue>> | null
  children: ExpandedCardNode[]
}

export type ExpandedCardTemplate = {
  vars: readonly (readonly [string, CardExpressionValue])[]
  frame: { singleLine: CardExpressionValue; statusLane: CardExpressionValue }
  root: ExpandedCardNode
}

/** Props an element accepts, or undefined when no such element exists. */
export type CardElementPropsLookup = (el: string) => readonly string[] | undefined

/** How far a template may expand; plugin templates get a tighter cap than Orca's own. */
export type CardExpansionCaps = { maxExpandedNodes: number }

class Expressions {
  // Why cached: a def reused at many places would otherwise compile its expressions each time.
  private readonly compiled = new Map<string, CardExpressionValue>()

  expression(source: string, path: string): CardExpressionValue {
    const cached = this.compiled.get(source)
    if (cached) {
      return cached
    }
    try {
      const evaluate = compileCardExpression(source).evaluate
      this.compiled.set(source, evaluate)
      return evaluate
    } catch (error) {
      throw new CardTemplateCompileError(
        error instanceof Error ? error.message : String(error),
        path
      )
    }
  }

  propValue(value: CardPropValue, path: string): CardExpressionValue {
    return isCardExpression(value) ? this.expression(value.slice(1), path) : () => value
  }
}

class Expander {
  private readonly expanding = new Set<string>()
  private expandedNodes = 0

  constructor(
    private readonly propsOf: CardElementPropsLookup,
    private readonly defs: Readonly<Record<string, CardTemplateNode>>,
    private readonly caps: CardExpansionCaps,
    private readonly expressions: Expressions
  ) {}

  /** `depth` is the node's depth in the expanded tree, since each def reference inlines a copy. */
  node(node: CardTemplateNode, path: string, depth = 1): ExpandedCardNode {
    const when =
      node.when === undefined ? null : this.expressions.expression(node.when, `${path}.when`)
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
      const innerWhen = inner.when
      return {
        ...inner,
        when: innerWhen ? (scope) => Boolean(when(scope)) && innerWhen(scope) : when
      }
    }
    // Why count expanded nodes: defs reused at each level multiply, so the schema's own count is no bound.
    if (++this.expandedNodes > this.caps.maxExpandedNodes) {
      throw new CardTemplateCompileError(
        `expands to more than ${this.caps.maxExpandedNodes} elements`,
        path
      )
    }
    if (depth > CARD_TEMPLATE_LIMITS.maxDepth) {
      throw new CardTemplateCompileError(
        `nested deeper than ${CARD_TEMPLATE_LIMITS.maxDepth}`,
        path
      )
    }
    const allowed = this.propsOf(node.el)
    if (!allowed) {
      throw new CardTemplateCompileError(`unknown element ${node.el}`, path)
    }
    const entries = Object.entries(node.props ?? {})
    for (const [name] of entries) {
      if (!allowed.includes(name)) {
        throw new CardTemplateCompileError(`${node.el} has no prop ${name}`, `${path}.props`)
      }
    }
    return {
      el: node.el,
      path,
      when,
      props: entries.map(([name, value]) => ({
        name,
        literal: !isCardExpression(value),
        value: this.expressions.propValue(value, `${path}.props.${name}`)
      })),
      literalProps: entries.every(([, value]) => !isCardExpression(value))
        ? Object.fromEntries(entries)
        : null,
      children: (node.children ?? []).map((child, index) =>
        this.node(child, `${path}.children[${index}]`, depth + 1)
      )
    }
  }
}

/** The one place a template's rules and caps are enforced: the renderer draws from its result,
 *  and plugin loading and `plugin check` call it to refuse what the renderer would. */
export function expandCardTemplate(
  template: CardTemplate,
  propsOf: CardElementPropsLookup,
  caps: CardExpansionCaps = CARD_TEMPLATE_LIMITS
): ExpandedCardTemplate {
  const expressions = new Expressions()
  const expander = new Expander(propsOf, template.defs ?? {}, caps, expressions)
  const frameFlag = (value: CardPropValue | undefined, path: string): CardExpressionValue =>
    value === undefined ? () => false : expressions.propValue(value, path)
  return {
    vars: Object.entries(template.vars ?? {}).map(
      ([name, source]) => [name, expressions.expression(source, `vars.${name}`)] as const
    ),
    frame: {
      singleLine: frameFlag(template.frame?.singleLine, 'frame.singleLine'),
      statusLane: frameFlag(template.frame?.statusLane, 'frame.statusLane')
    },
    root: expander.node(template.root, 'root')
  }
}
