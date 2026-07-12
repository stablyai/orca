import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const RENDERER_ROOT = resolve('src/renderer/src')

const FUNCTION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor
])

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const filePath = resolve(dir, name)
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      collectSourceFiles(filePath, files)
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.test\.(ts|tsx)$/.test(name) &&
      !filePath.includes('/i18n/locales/')
    ) {
      files.push(filePath)
    }
  }
  return files
}

function isInsideFunction(node: ts.Node): boolean {
  let parent = node.parent
  while (parent && parent.kind !== ts.SyntaxKind.SourceFile) {
    if (FUNCTION_KINDS.has(parent.kind)) {
      return true
    }
    parent = parent.parent
  }
  return false
}

describe('i18n import-time safety', () => {
  it('does not evaluate translate() at module load time', () => {
    const violations: string[] = []

    for (const filePath of collectSourceFiles(RENDERER_ROOT)) {
      const source = readFileSync(filePath, 'utf8')
      if (!source.includes('translate(')) {
        continue
      }
      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      )

      function visit(node: ts.Node): void {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(sourceFile) === 'translate' &&
          !isInsideFunction(node)
        ) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile)
          )
          violations.push(`${relative(process.cwd(), filePath)}:${line + 1}:${character + 1}`)
        }
        ts.forEachChild(node, visit)
      }

      visit(sourceFile)
    }

    expect(violations).toEqual([])
  }, 15_000)
})
