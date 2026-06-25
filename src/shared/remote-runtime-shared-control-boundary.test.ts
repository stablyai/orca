import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const FORBIDDEN_REMOTE_SERVER_IMPORTS = [
  'remote-runtime-shared-control',
  'runtime-environment-request-connections'
]

describe('remote runtime shared-control transport boundary', () => {
  it.each(['src/main/ssh', 'src/relay'])(
    'does not couple %s to remote-server shared-control transport',
    (root) => {
      const offenders = collectTypeScriptFiles(root).filter((file) => {
        const source = readFileSync(file, 'utf8')
        return collectModuleSpecifiers(file, source).some((specifier) =>
          FORBIDDEN_REMOTE_SERVER_IMPORTS.some((pattern) => specifier.includes(pattern))
        )
      })

      expect(offenders).toEqual([])
    }
  )
})

function collectTypeScriptFiles(root: string): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...collectTypeScriptFiles(path))
      continue
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      files.push(path)
    }
  }
  return files
}

function collectModuleSpecifiers(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text)
    }
    if (
      ts.isCallExpression(node) &&
      isModuleLoader(node.expression) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  return specifiers
}

function isModuleLoader(expression: ts.Expression): boolean {
  return (
    expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'require')
  )
}
