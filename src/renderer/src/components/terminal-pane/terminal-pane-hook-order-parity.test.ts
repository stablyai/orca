import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const TERMINAL_PANE_HOOK_SOURCE_PATTERN =
  /^(?:TerminalPane\.tsx|use-terminal-pane-(?:chat-state|close-actions|context-actions|controller|foundation|global-listeners|layout-bindings|layout-persistence|lifecycle-stage|mobile-actions|paste-listeners|process-exit-actions|projection|reconciliation|startup-actions|store-actions|store-bindings|title-effects|title-state)\.ts)$/
// Rebased onto main after the workbench surface-per-workspace and deferred
// split-cwd changes; the pane session-ID projection added one render hook (230 hooks).
// Then 27 stable-action `useAppStore` subscriptions folded into four
// `useTerminalPaneStoreActions()` calls, each one `useMemo` (204 hooks, 8 useMemo).
// Restoring the terminal/chat switcher added four `useCallback`s -- three in
// chat-state (can-toggle, toggle-for-leaf, toggle-active) and the context-menu
// toggle in projection (208 hooks, still 8 useMemo).
const PRE_REFACTOR_HOOK_ORDER_SHA256 =
  '983ad067c9feca82c5435eb1b865674344489c368ec2007dc7bb40c81aef037c'

const sourceFiles = readdirSync(__dirname)
  .filter((name) => TERMINAL_PANE_HOOK_SOURCE_PATTERN.test(name))
  .sort()

function readFunctionDefinitions(): Map<string, ts.FunctionDeclaration> {
  const definitions = new Map<string, ts.FunctionDeclaration>()
  for (const relativePath of sourceFiles) {
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
        (node.name.text === 'TerminalPane' || node.name.text.startsWith('useTerminalPane'))
      ) {
        definitions.set(node.name.text, node)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return definitions
}

function readFlattenedHookOrder(): string[] {
  const definitions = readFunctionDefinitions()
  const flatten = (name: string, active: ReadonlySet<string>): string[] => {
    const definition = definitions.get(name)
    if (!definition?.body) {
      throw new Error(`Missing terminal pane hook stage: ${name}`)
    }
    if (active.has(name)) {
      throw new Error(`Recursive terminal pane hook stage: ${name}`)
    }
    const nextActive = new Set([...active, name])
    const hooks: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^use[A-Z]/.test(node.expression.text)
      ) {
        const hookName = node.expression.text
        hooks.push(...(definitions.has(hookName) ? flatten(hookName, nextActive) : [hookName]))
      }
      ts.forEachChild(node, visit)
    }
    visit(definition.body)
    return hooks
  }

  return flatten('TerminalPane', new Set())
}

describe('TerminalPane refactor hook parity', () => {
  it('preserves the recursively flattened render hook order', () => {
    const hooks = readFlattenedHookOrder()
    expect(hooks).toHaveLength(208)
    expect(hooks.filter((hook) => hook === 'useMemo')).toHaveLength(8)
    expect(createHash('sha256').update(hooks.join('\n')).digest('hex')).toBe(
      PRE_REFACTOR_HOOK_ORDER_SHA256
    )
  })

  it('aggregates every extracted hook stage', () => {
    expect(sourceFiles).toHaveLength(20)
    expect(sourceFiles).toContain('TerminalPane.tsx')
    expect(sourceFiles).toContain('use-terminal-pane-controller.ts')
  })

  it('defers quick-command host work until the context menu opens', () => {
    const startupSource = readFileSync(
      join(__dirname, 'use-terminal-pane-startup-actions.ts'),
      'utf8'
    )
    const contextSource = readFileSync(
      join(__dirname, 'use-terminal-pane-context-actions.ts'),
      'utf8'
    )

    expect(startupSource).toContain('const quickCommandRepoId =')
    expect(startupSource).not.toContain('useTerminalQuickCommandHosts')
    expect(contextSource).toContain('useTerminalQuickCommandHosts(worktreeId, contextMenu.open)')
    expect(contextSource).toContain('terminalQuickCommandMatchesWorkspaceProject')
    expect(contextSource).toContain('projectHostSetupProjection.setups')
    expect(contextSource).toContain('quickCommandExecutionHostId')
  })
})
