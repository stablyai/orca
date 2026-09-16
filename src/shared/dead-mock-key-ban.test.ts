import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { parseAst as ParseAstFn } from 'vite' with { 'resolution-mode': 'import' }
import type { AstNode, ParseProgram } from './source-scan/module-export-names'
import { readExportedNames, resolveRelativeModule } from './source-scan/module-export-names'
import { scanSourceTree } from './source-scan/source-tree-scan'

// Dynamic import: vite is ESM-only and this file typechecks under tsconfig.tc.cli.json's node16/CJS.
let parseAst: typeof ParseAstFn

beforeAll(async () => {
  ;({ parseAst } = await import('vite'))
})

/**
 * Ban `vi.mock` factory keys that name nothing the mocked module exports.
 *
 * A key that matches no export is not a stub -- it is a comment. The module
 * registry serves it to nobody, production keeps calling the real function, and
 * the suite goes green for a reason its author did not intend. Nothing else
 * catches this: it typechecks (a factory is a plain object literal), it does not
 * warn at runtime, and the tell only shows if you make the key throw and notice
 * that nothing happens.
 *
 * It found 83 such keys across 73 suites on the commit that introduced it,
 * in seven clusters. The two largest were symbols that had been renamed or moved
 * out of the mocked module, leaving eight SSH-relay suites and 56 terminal-pane
 * suites each carrying a stub that had never once been reached.
 */

type MockCall = { specifier: string; keys: string[] }

/** Unwraps a factory to the object literal it yields, or null if not statically known. */
function factoryObject(node: AstNode | undefined): AstNode | null {
  let current: AstNode | undefined = node
  if (current?.type === 'ArrowFunctionExpression' || current?.type === 'FunctionExpression') {
    // A concise arrow body is one node; a block body is a statement list.
    current = Array.isArray(current.body) ? undefined : current.body
    if (current?.type === 'BlockStatement') {
      const statements = Array.isArray(current.body) ? current.body : []
      current = statements.findLast((statement) => statement.type === 'ReturnStatement')?.argument
    }
  }
  const TRANSPARENT = [
    'TSAsExpression',
    'ParenthesizedExpression',
    'AwaitExpression',
    'TSSatisfiesExpression'
  ]
  while (current && TRANSPARENT.includes(current.type)) {
    current = current.expression ?? current.argument
  }
  return current?.type === 'ObjectExpression' ? current : null
}

/**
 * Every statically readable `vi.mock`/`vi.doMock` in a file.
 *
 * A factory whose keys cannot all be read -- a computed key, or a returned
 * identifier -- is dropped whole rather than half-checked, so the guard never
 * accuses a key it did not actually see.
 */
function readMockCalls(program: { body: AstNode[] }): MockCall[] {
  const calls: MockCall[] = []
  const stack: unknown[] = [program]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') {
      continue
    }
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    const candidate = node as AstNode
    const callee = candidate.callee
    if (
      candidate.type === 'CallExpression' &&
      callee?.type === 'MemberExpression' &&
      callee.object?.name === 'vi' &&
      (callee.property?.name === 'mock' || callee.property?.name === 'doMock')
    ) {
      calls.push(...readMockCall(candidate))
    }
    stack.push(...Object.values(candidate as Record<string, unknown>))
  }
  return calls
}

function readMockCall(call: AstNode): MockCall[] {
  const args = call.arguments ?? []
  const target = args[0]
  // `vi.mock(import('./x'), ...)` names its module through an import expression.
  const specifier = target?.type === 'Literal' ? target.value : target?.source?.value
  const object = factoryObject(args[1])
  if (typeof specifier !== 'string' || !object) {
    return []
  }
  const keys: string[] = []
  for (const property of object.properties ?? []) {
    // A spread carries the real module's exports through; its own keys are not ours to judge.
    if (property.type === 'SpreadElement') {
      continue
    }
    const key = property.computed ? undefined : (property.key?.name ?? property.key?.value)
    if (typeof key !== 'string') {
      return []
    }
    keys.push(key)
  }
  return [{ specifier, keys }]
}

describe('dead vi.mock factory keys', () => {
  const repoRoot = resolve(__dirname, '..', '..')
  const offenders: string[] = []
  const phantomPaths: string[] = []
  const unparseable: string[] = []
  let filesScanned = 0
  let mockCallsSeen = 0
  let mockCallsChecked = 0

  beforeAll(() => {
    const scanned = scanSourceTree(resolve(repoRoot, 'src'), { includeTests: true })
    filesScanned = scanned.length
    // One pass to hold every file's text, so a mocked module is readable whether or
    // not the walk has reached it yet.
    const sources = new Map(scanned.map((file) => [file.path, file.source]))
    const parse: ParseProgram = (file) =>
      parseAst(sources.get(file) ?? '', {
        lang: file.endsWith('.tsx') ? 'tsx' : 'ts'
      }) as unknown as { body: AstNode[] }
    const exportCache = new Map<string, ReturnType<typeof readExportedNames>>()
    const exportsOf = (file: string): ReturnType<typeof readExportedNames> => {
      const cached = exportCache.get(file)
      if (cached) {
        return cached
      }
      const read = readExportedNames(file, parse)
      exportCache.set(file, read)
      return read
    }

    for (const file of scanned) {
      if (!/vi\.(?:mock|doMock)\s*\(/.test(file.source)) {
        continue
      }
      let program: { body: AstNode[] }
      try {
        program = parse(file.path)
      } catch {
        // Fail closed: a file the guard cannot read is not a file the guard cleared.
        unparseable.push(file.relativePath)
        continue
      }
      for (const call of readMockCalls(program)) {
        mockCallsSeen += 1
        const target = resolveRelativeModule(file.path, call.specifier)
        if (!target) {
          // A relative path that resolves to nothing is the same bug one level up:
          // the whole factory is dead, not just a key. `?asset`-style specifiers are
          // resolved by a bundler plugin, not by the filesystem, so they are exempt.
          if (call.specifier.startsWith('.') && !call.specifier.includes('?')) {
            phantomPaths.push(`${file.relativePath}: vi.mock('${call.specifier}')`)
          }
          continue
        }
        const { names, complete } = exportsOf(target)
        if (!complete) {
          continue
        }
        mockCallsChecked += 1
        for (const key of call.keys.filter((name) => !names.has(name))) {
          offenders.push(`${file.relativePath}: vi.mock('${call.specifier}') key '${key}'`)
        }
      }
    }
  })

  it('scans a plausible amount of the tree', () => {
    // Counting what the filter saw, not just what it reported: a broken walk or a
    // regressed AST shape would make every assertion below vacuously green.
    expect(filesScanned).toBeGreaterThan(5000)
    expect(mockCallsSeen).toBeGreaterThan(2000)
    expect(mockCallsChecked).toBeGreaterThan(1000)
  })

  it('parses every file that mocks a module', () => {
    expect(unparseable).toEqual([])
  })

  it('mocks no relative path that resolves to no module', () => {
    expect(
      phantomPaths,
      'This vi.mock names a relative path with no module behind it, so the whole factory is ' +
        'inert and the real module loads. Correct the path.'
    ).toEqual([])
  })

  it('has no factory key that the mocked module does not export', () => {
    expect(
      offenders,
      'This vi.mock key matches no export of that module, so the mock never applies and the ' +
        'real implementation runs. Point it at the module that actually exports the symbol, ' +
        'fix the name, or delete the key.'
    ).toEqual([])
  })
})
