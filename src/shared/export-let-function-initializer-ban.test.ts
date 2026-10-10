import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { parseAst as ParseAstFn } from 'vite' with { 'resolution-mode': 'import' }
import { scanSourceTree } from './source-scan/source-tree-scan'

// Dynamic import: vite is ESM-only and this file typechecks under tsconfig.tc.cli.json's node16/CJS.
let parseAst: typeof ParseAstFn

beforeAll(async () => {
  ;({ parseAst } = await import('vite'))
})

/**
 * Ban `export let fn = <function>` tree-wide: rolldown const-folds the
 * initializer into call sites and drops the setter's reassignment, so the
 * bridged closure silently never runs in the built app (dev is fine). Use a
 * module-local null-initialized impl var behind exported wrapper functions
 * instead (see src/main/ipc/pty/delivery/debug.ts); null-initialized
 * `export let` slots compile correctly and stay allowed. Detection uses
 * vite/rolldown's own oxc parser so this test sees exactly what the bundler sees.
 */

type AstNode = {
  type: string
  start?: number
  expression?: AstNode
  expressions?: AstNode[]
  declaration?: AstNode
  kind?: string
  declarations?: {
    id?: { name?: string }
    init?: AstNode | null
    start?: number
  }[]
  specifiers?: { local?: { name?: string } }[]
}

/** Casts, parens, `!`, and comma sequences around the function don't change what rolldown folds. */
function unwrapInitializer(node: AstNode): AstNode {
  let current = node
  for (;;) {
    if (
      current.expression &&
      [
        'ParenthesizedExpression',
        'TSAsExpression',
        'TSSatisfiesExpression',
        'TSTypeAssertion',
        'TSNonNullExpression'
      ].includes(current.type)
    ) {
      current = current.expression
      continue
    }
    // A sequence evaluates to its last expression — that's what gets folded.
    const sequenceTail =
      current.type === 'SequenceExpression' ? current.expressions?.at(-1) : undefined
    if (sequenceTail) {
      current = sequenceTail
      continue
    }
    return current
  }
}

export type FunctionInitializedExportLet = { name: string; line: number }

export function findFunctionInitializedExportLets(
  fileName: string,
  sourceText: string
): FunctionInitializedExportLet[] {
  // Cheap prefilter: full parses only for files that could contain the pattern.
  if (!/\bexport\b/.test(sourceText) || !/\blet\b/.test(sourceText)) {
    return []
  }
  const lineOf = (offset: number): number => sourceText.slice(0, offset).split('\n').length
  const program = parseAst(sourceText, {
    lang: fileName.endsWith('.tsx') ? 'tsx' : 'ts'
  }) as unknown as { body: AstNode[] }
  const functionLets: (FunctionInitializedExportLet & { exported: boolean })[] = []
  const exportedNames = new Set<string>()
  const collectLets = (declaration: AstNode | undefined, exported: boolean): void => {
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'let') {
      return
    }
    for (const declarator of declaration.declarations ?? []) {
      const initializer = declarator.init && unwrapInitializer(declarator.init)
      if (
        initializer &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(initializer.type)
      ) {
        functionLets.push({
          name: declarator.id?.name ?? '<destructured>',
          line: lineOf(declarator.start ?? 0),
          exported
        })
      }
    }
  }
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      collectLets(statement.declaration, true)
      // `let fn = () => {}; export { fn }` is the same live binding — same hazard.
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.local?.name) {
          exportedNames.add(specifier.local.name)
        }
      }
      continue
    }
    collectLets(statement, false)
  }
  return functionLets
    .filter((candidate) => candidate.exported || exportedNames.has(candidate.name))
    .map(({ name, line }) => ({ name, line }))
}

describe('function-initialized export let ban', () => {
  it('flags the shapes rolldown miscompiles', () => {
    const flagged = [
      'export let f = () => {}',
      'export let f = function () {}',
      'export let f = async () => {}',
      'export let f = (() => {}) as () => void',
      'export let f = (() => {})!',
      'export let f = (0, () => {})',
      'export let f: (id: string) => void = (_id) => {}',
      'let f = () => {}\nexport { f }',
      'let f = () => {}\nexport { f as g }'
    ]
    for (const source of flagged) {
      expect(findFunctionInitializedExportLets('a.ts', source), source).toHaveLength(1)
    }
  })

  it('reports the declaration line', () => {
    const source = 'const a = 1\n\nexport let f = () => {}'
    expect(findFunctionInitializedExportLets('a.ts', source)).toEqual([{ name: 'f', line: 3 }])
  })

  it('allows the safe shapes', () => {
    const allowed = [
      'export let f: (() => void) | null = null',
      'export const f = () => {}',
      'let f = () => {}',
      'let f: (() => void) | null = null\nexport { f }',
      'export let n = 0',
      'export let f'
    ]
    for (const source of allowed) {
      expect(findFunctionInitializedExportLets('a.ts', source), source).toEqual([])
    }
  })

  const repoRoot = resolve(__dirname, '..', '..')
  // Tests are not rolldown-bundled (scanSourceTree excludes them by default);
  // several drive the banned shape on purpose.
  const files = scanSourceTree(join(repoRoot, 'src'))

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('has no function-initialized export let in shipped code', () => {
    const offenders = files.flatMap(({ relativePath, source }) =>
      findFunctionInitializedExportLets(relativePath, source).map(
        (offender) => `src/${relativePath}:${offender.line} (${offender.name})`
      )
    )
    expect(
      offenders,
      'Rolldown miscompiles `export let fn = <function>` bridges: the initializer is folded into call sites and the setter reassignment is dropped in the built app. Use a module-local null-initialized impl var behind an exported wrapper function instead — see src/main/ipc/pty/delivery/debug.ts.'
    ).toEqual([])
  })
})
