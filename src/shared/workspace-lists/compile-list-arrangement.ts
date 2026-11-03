import { compileCardExpression, readCardFactPath } from '../workspace-cards/card-expression'
import type { ListArrangement } from './list-arrangement-schema'
import type { WorkspaceListFacts } from './workspace-list-facts'

export type CompiledListArrangement = {
  sections: readonly { id: string; title: string; collapsed: boolean }[]
  /** Index into `sections` for one workspace. */
  sectionOf: (facts: WorkspaceListFacts) => number
  /** Orders two workspaces of one section; 0 keeps the person's own order. */
  compare: (left: WorkspaceListFacts, right: WorkspaceListFacts) => number
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left ? -1 : 1
  }
  return String(left).localeCompare(String(right))
}

/** Compile once per arrangement; per workspace it only evaluates small pure expressions. */
export function compileListArrangement(arrangement: ListArrangement): CompiledListArrangement {
  const vars = Object.entries(arrangement.vars ?? {}).map(
    ([name, source]) => [name, compileCardExpression(source).evaluate] as const
  )
  const rules = arrangement.sections.map((section) =>
    section.when === undefined ? null : compileCardExpression(section.when).evaluate
  )
  const fallbackIndex = arrangement.fallback
    ? arrangement.sections.findIndex((section) => section.id === arrangement.fallback)
    : arrangement.sections.length - 1
  const keys = (arrangement.sort ?? []).map((key) => ({
    segments: key.by.split('.'),
    sign: key.dir === 'desc' ? -1 : 1
  }))
  const scopeOf = (facts: WorkspaceListFacts): Record<string, unknown> => {
    const values: Record<string, unknown> = {}
    const scope: Record<string, unknown> = { ...facts, vars: values }
    for (const [name, evaluate] of vars) {
      values[name] = evaluate(scope)
    }
    return scope
  }
  return {
    sections: arrangement.sections.map((section) => ({
      id: section.id,
      title: section.title,
      collapsed: section.collapsed === true
    })),
    sectionOf: (facts) => {
      const scope = scopeOf(facts)
      // A section with no rule takes every workspace that reaches it.
      const index = rules.findIndex((rule) => rule === null || Boolean(rule(scope)))
      return index === -1 ? fallbackIndex : index
    },
    compare: (left, right) => {
      for (const key of keys) {
        const a = readCardFactPath(left, key.segments)
        const b = readCardFactPath(right, key.segments)
        // Missing values sort last in both directions.
        if (isMissing(a) !== isMissing(b)) {
          return isMissing(a) ? 1 : -1
        }
        const order = compareValues(a, b) * key.sign
        if (order !== 0) {
          return order
        }
      }
      return 0
    }
  }
}
