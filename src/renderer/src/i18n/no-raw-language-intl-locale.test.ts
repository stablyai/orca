/**
 * Plugin language packs make `i18n.language` a synthetic `plugin<hex>` tag that
 * every `Intl` constructor rejects with a RangeError, so Intl locales must come
 * from `getIntlLocale()`. This catches the two shapes that shipped that crash:
 * the raw language passed straight to Intl, or held in a `locale` variable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const RENDERER_ROOT = resolve('src/renderer/src')
const LOCALE_METHODS = new Set([
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'localeCompare'
])
const RAW_LANGUAGE = /\b(?:i18n|i18next)\??\.(?:language|resolvedLanguage)\b/

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const filePath = resolve(dir, name)
    if (statSync(filePath).isDirectory()) {
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

function isLocaleSink(node: ts.CallExpression | ts.NewExpression, file: ts.SourceFile): boolean {
  const callee = node.expression
  if (callee.getText(file).startsWith('Intl.')) {
    return true
  }
  return ts.isPropertyAccessExpression(callee) && LOCALE_METHODS.has(callee.name.text)
}

describe('Intl locale source', () => {
  it('never feeds the raw i18n language to Intl', () => {
    const violations: string[] = []

    for (const filePath of collectSourceFiles(RENDERER_ROOT)) {
      const source = readFileSync(filePath, 'utf8')
      if (!RAW_LANGUAGE.test(source)) {
        continue
      }
      const file = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      )
      const report = (node: ts.Node): void => {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        violations.push(`${relative(process.cwd(), filePath)}:${line + 1}`)
      }

      function visit(node: ts.Node): void {
        if (
          (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
          isLocaleSink(node, file) &&
          node.arguments?.some((arg) => RAW_LANGUAGE.test(arg.getText(file)))
        ) {
          report(node)
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          /^locale$/i.test(node.name.text) &&
          node.initializer &&
          RAW_LANGUAGE.test(node.initializer.getText(file))
        ) {
          report(node)
        }
        ts.forEachChild(node, visit)
      }

      visit(file)
    }

    expect(violations).toEqual([])
  }, 15_000)
})
