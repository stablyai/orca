import {
  compileCardExpression,
  type CardExpressionValue,
  type CompiledCardExpression
} from './card-expression'
import { cardFactListItems, cardFactPathIssue, type CardFactPathNode } from './card-fact-paths'
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
  /** Set on `Each`: the list to draw children for, at most `limit` items. */
  each?: { items: CardExpressionValue; limit: number }
  children: ExpandedCardNode[]
}

export type ExpandedCardTemplate = {
  vars: readonly (readonly [string, CardExpressionValue])[]
  frame: { singleLine: CardExpressionValue; statusLane: CardExpressionValue }
  root: ExpandedCardNode
  /** Fact domains the template reads, so a card subscribes only to what it draws. */
  roots: ReadonlySet<string>
}

/** Props an element accepts, or undefined when no such element exists. */
export type CardElementPropsLookup = (el: string) => readonly string[] | undefined

/** How far a template may expand; plugin templates get a tighter cap than Orca's own. */
export type CardExpansionCaps = { maxExpandedNodes: number }

export type CardExpansionOptions = {
  caps?: CardExpansionCaps
  /** The person's language, choosing which of the template's `strings` `t()` reads. */
  locale?: string
}

/** The template's strings for a language: exact tag, then its language, then `en`. */
export function cardTemplateStrings(
  template: CardTemplate,
  locale: string | undefined
): Readonly<Record<string, string>> {
  const all = template.strings ?? {}
  const pick = (tag: string | undefined) =>
    tag !== undefined && Object.hasOwn(all, tag) ? all[tag] : undefined
  return { ...pick('en'), ...pick(locale?.split('-')[0]), ...pick(locale) }
}

class Expressions {
  // Why cached: a def reused at many places would otherwise compile its expressions each time.
  private readonly compiled = new Map<string, CompiledCardExpression>()
  readonly roots = new Set<string>()

  constructor(private readonly strings: Readonly<Record<string, string>>) {}

  private compile(source: string, path: string): CompiledCardExpression {
    const cached = this.compiled.get(source)
    if (cached) {
      return cached
    }
    try {
      const compiled = compileCardExpression(source, { strings: this.strings })
      this.compiled.set(source, compiled)
      return compiled
    } catch (error) {
      throw new CardTemplateCompileError(
        error instanceof Error ? error.message : String(error),
        path
      )
    }
  }

  /** Compiles and checks every fact it reads; `item` is the enclosing `Each`'s item shape. */
  expression(source: string, path: string, item: CardFactPathNode | null): CompiledCardExpression {
    const compiled = this.compile(source, path)
    for (const segments of compiled.paths) {
      const issue = cardFactPathIssue(segments, item)
      if (issue) {
        throw new CardTemplateCompileError(issue, path)
      }
    }
    for (const root of compiled.roots) {
      this.roots.add(root)
    }
    return compiled
  }

  propValue(
    value: CardPropValue,
    path: string,
    item: CardFactPathNode | null
  ): CardExpressionValue {
    return isCardExpression(value)
      ? this.expression(value.slice(1), path, item).evaluate
      : () => value
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
  node(
    node: CardTemplateNode,
    path: string,
    depth: number,
    item: CardFactPathNode | null
  ): ExpandedCardNode {
    const when =
      node.when === undefined
        ? null
        : this.expressions.expression(node.when, `${path}.when`, item).evaluate
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
      const inner = this.node(def, `defs.${node.el}`, depth, item)
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
    const each = node.el === 'Each' ? this.each(node, path, item) : null
    const childItem = each ? each.item : item
    const props = node.el === 'Each' ? [] : entries
    return {
      el: node.el,
      path,
      when,
      props: props.map(([name, value]) => ({
        name,
        literal: !isCardExpression(value),
        value: this.expressions.propValue(value, `${path}.props.${name}`, item)
      })),
      literalProps: props.every(([, value]) => !isCardExpression(value))
        ? Object.fromEntries(props)
        : null,
      ...(each ? { each: { items: each.items, limit: each.limit } } : {}),
      children: (node.children ?? []).map((child, index) =>
        this.node(child, `${path}.children[${index}]`, depth + 1, childItem)
      )
    }
  }

  /** `Each` names a list fact; its children then read one item as `item.*`. */
  private each(
    node: CardTemplateNode,
    path: string,
    item: CardFactPathNode | null
  ): { items: CardExpressionValue; limit: number; item: CardFactPathNode } {
    const source = node.props?.items
    const segments = isCardExpression(source) ? source.slice(1).trim().split('.') : null
    const itemShape = segments ? cardFactListItems(segments, item) : null
    if (!isCardExpression(source) || !itemShape) {
      throw new CardTemplateCompileError(
        'Each needs items naming a list fact, such as "=activity.agents"',
        `${path}.props.items`
      )
    }
    const limit = node.props?.limit
    const max = CARD_TEMPLATE_LIMITS.maxEachItems
    return {
      items: this.expressions.expression(source.slice(1), `${path}.props.items`, item).evaluate,
      limit: typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), max) : max,
      item: itemShape
    }
  }
}

/** The one place a template's rules and caps are enforced: the renderer draws from its result,
 *  and plugin loading and `plugin check` call it to refuse what the renderer would. */
export function expandCardTemplate(
  template: CardTemplate,
  propsOf: CardElementPropsLookup,
  options: CardExpansionOptions = {}
): ExpandedCardTemplate {
  const expressions = new Expressions(cardTemplateStrings(template, options.locale))
  const caps = options.caps ?? CARD_TEMPLATE_LIMITS
  const expander = new Expander(propsOf, template.defs ?? {}, caps, expressions)
  const frameFlag = (value: CardPropValue | undefined, path: string): CardExpressionValue =>
    value === undefined ? () => false : expressions.propValue(value, path, null)
  const vars = Object.entries(template.vars ?? {}).map(
    ([name, source]) =>
      [name, expressions.expression(source, `vars.${name}`, null).evaluate] as const
  )
  const frame = {
    singleLine: frameFlag(template.frame?.singleLine, 'frame.singleLine'),
    statusLane: frameFlag(template.frame?.statusLane, 'frame.statusLane')
  }
  const root = expander.node(template.root, 'root', 1, null)
  // `vars` is the template's own namespace, not a fact domain.
  expressions.roots.delete('vars')
  return { vars, frame, root, roots: expressions.roots }
}
