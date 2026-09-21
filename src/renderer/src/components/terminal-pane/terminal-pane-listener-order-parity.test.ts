import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const LISTENER_SOURCE_PATTERN =
  /^(?:TerminalPane\.tsx|terminal-pane-paste-listeners\.ts|use-terminal-pane-(?:chat-state|close-actions|context-actions|controller|foundation|global-listeners|layout-bindings|layout-persistence|lifecycle-stage|mobile-actions|paste-listeners|projection|reconciliation|startup-actions|store-bindings|title-effects|title-state)\.ts)$/
const PRE_REFACTOR_LISTENER_ORDER_SHA256 =
  '2a2c5caaa368636d761ec819a7858f6b8010e578ccdd5c1be5960f87968c7e8a'

type FunctionDefinition = { declaration: ts.FunctionDeclaration; sourceFile: ts.SourceFile }

function readDefinitions(): Map<string, FunctionDefinition> {
  const definitions = new Map<string, FunctionDefinition>()
  for (const relativePath of readdirSync(__dirname).filter((name) =>
    LISTENER_SOURCE_PATTERN.test(name)
  )) {
    const filePath = join(__dirname, relativePath)
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        (node.name.text === 'TerminalPane' ||
          node.name.text === 'registerTerminalPanePasteListeners' ||
          node.name.text.startsWith('useTerminalPane'))
      ) {
        definitions.set(node.name.text, { declaration: node, sourceFile })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return definitions
}

function readFlattenedListeners(): string[] {
  const definitions = readDefinitions()
  const listeners: string[] = []
  const visitDefinition = (name: string, active: ReadonlySet<string>): void => {
    const definition = definitions.get(name)
    if (!definition?.declaration.body) {
      throw new Error(`Missing terminal pane stage: ${name}`)
    }
    if (active.has(name)) {
      throw new Error(`Recursive terminal pane stage: ${name}`)
    }
    const nextActive = new Set([...active, name])
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ['addEventListener', 'removeEventListener'].includes(node.expression.name.text)
        ) {
          listeners.push(
            [
              node.expression.expression.getText(definition.sourceFile),
              node.expression.name.text,
              ...node.arguments.map((argument) =>
                argument.getText(definition.sourceFile).replace(/\s+/g, '')
              )
            ].join('|')
          )
        }
        if (ts.isIdentifier(node.expression) && definitions.has(node.expression.text)) {
          visitDefinition(node.expression.text, nextActive)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(definition.declaration.body)
  }

  visitDefinition('TerminalPane', new Set())
  return listeners
}

describe('TerminalPane refactor listener parity', () => {
  it('preserves ordered listener registration and cleanup', () => {
    const listeners = readFlattenedListeners()
    expect(listeners).toHaveLength(24)
    expect(createHash('sha256').update(listeners.join('\n')).digest('hex')).toBe(
      PRE_REFACTOR_LISTENER_ORDER_SHA256
    )
  })
})
