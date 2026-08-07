import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = join(process.cwd(), 'src')

type LazyCall = { file: string; line: number; reloadKey: string | null }

function sourceFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
      ? [path]
      : []
  })
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
}

function lazyCalls(filePath: string): LazyCall[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const localNames = new Set<string>()
  const calls: LazyCall[] = []

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith('/lazy-with-retry')
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue
    }
    for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === 'lazyWithRetry') {
        localNames.add(binding.name.text)
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text)
    ) {
      const options = node.arguments[1]
      const reloadKeyProperty =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'reloadKey'
            )
          : undefined
      const reloadKey =
        reloadKeyProperty && ts.isStringLiteral(reloadKeyProperty.initializer)
          ? reloadKeyProperty.initializer.text
          : null
      calls.push({
        file: relative(process.cwd(), filePath),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        reloadKey
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

describe('lazy chunk recovery diagnostics', () => {
  it('names every renderer lazyWithRetry call site', () => {
    const calls = sourceFiles().flatMap(lazyCalls)
    const unnamed = calls
      .filter((call) => !call.reloadKey)
      .map((call) => `${call.file}:${call.line}`)

    expect(calls.length).toBeGreaterThanOrEqual(70)
    expect(unnamed).toEqual([])
  })
})
