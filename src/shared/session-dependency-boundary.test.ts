import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript-api'
import { expect, it } from 'vitest'

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path) && !/test|spec|fixtures/.test(path)
        ? [path]
        : []
  })
}

it('keeps raw owner references and tab-owner interpretation inside the dependency reader', () => {
  const root = join(process.cwd(), 'src')
  const boundaries = new Set([
    'shared/session-unit-index.ts',
    'shared/session-reader-queries.ts',
    'shared/session-unit-reader.ts',
    'shared/session-unit-selection.ts'
  ])
  const exactMembership = new Set([
    'main/persistence/loading-store/reused-terminal-id-unbind.ts',
    'main/persistence/loading-store/layout-editor-views.ts',
    'main/persistence/restoring-sessions/session-owner-reduction.ts',
    'main/persistence/tracking-repos/session-identity-reduction.ts',
    'main/persistence/terminal-topology/terminal-topology-membership.ts'
  ])
  const violations: string[] = []
  for (const path of files(root)) {
    const name = relative(root, path)
    if (boundaries.has(name)) {
      continue
    }
    const text = readFileSync(path, 'utf8')
    if (/\bdependencyIds\b/.test(text)) {
      violations.push(`${name}: raw dependency ids`)
    }
    if (exactMembership.has(name)) {
      continue
    }
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'filter'
      ) {
        const source = node.expression.expression.getText(tree)
        const predicate = node.arguments.map((argument) => argument.getText(tree)).join(' ')
        if (
          /references\(\s*['"]tab['"]/.test(source) &&
          /['"](?:tabsByWorktree|unifiedTabs)['"]/.test(predicate)
        ) {
          violations.push(`${name}: handwritten tab owner`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  expect(violations).toEqual([])
})
