import { compileCardExpression } from './card-expression'
import { CARD_ELEMENT_PROPS, isCardElementName } from './card-element-catalog'
import { isCardExpression, type CardTemplate, type CardTemplateNode } from './card-template-schema'

function defsUsedBy(node: CardTemplateNode, defs: Readonly<Record<string, unknown>>): string[] {
  const own = Object.hasOwn(defs, node.el) ? [node.el] : []
  return [...own, ...(node.children ?? []).flatMap((child) => defsUsedBy(child, defs))]
}

/** What Orca's renderer would refuse to compile, as `path: message` lines; empty when valid. */
export function cardTemplateIssues(template: CardTemplate): string[] {
  const issues: string[] = []
  const defs = template.defs ?? {}
  const expression = (source: string, path: string): void => {
    try {
      compileCardExpression(source)
    } catch (error) {
      issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const visit = (node: CardTemplateNode, path: string): void => {
    if (node.when !== undefined) {
      expression(node.when, `${path}.when`)
    }
    if (!Object.hasOwn(defs, node.el)) {
      if (!isCardElementName(node.el)) {
        issues.push(`${path}: unknown element ${node.el}`)
      } else {
        const allowed: readonly string[] = CARD_ELEMENT_PROPS[node.el]
        for (const [name, value] of Object.entries(node.props ?? {})) {
          if (!allowed.includes(name)) {
            issues.push(`${path}.props: ${node.el} has no prop ${name}`)
          } else if (isCardExpression(value)) {
            expression(value.slice(1), `${path}.props.${name}`)
          }
        }
      }
    }
    node.children?.forEach((child, index) => visit(child, `${path}.children[${index}]`))
  }

  for (const [name, source] of Object.entries(template.vars ?? {})) {
    expression(source, `vars.${name}`)
  }
  for (const [name, value] of Object.entries(template.frame ?? {})) {
    if (isCardExpression(value)) {
      expression(value.slice(1), `frame.${name}`)
    }
  }
  // Why depth-first over names: a def that reaches itself would expand forever.
  const cycleFrom = (name: string, chain: readonly string[]): boolean => {
    if (chain.includes(name)) {
      return true
    }
    const def = defs[name]
    return def ? defsUsedBy(def, defs).some((next) => cycleFrom(next, [...chain, name])) : false
  }
  for (const [name, def] of Object.entries(defs)) {
    if (cycleFrom(name, [])) {
      issues.push(`defs.${name}: uses itself`)
    }
    visit(def, `defs.${name}`)
  }
  visit(template.root, 'root')
  return issues
}
