import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { parseAst as ParseAstFn } from 'vite' with { 'resolution-mode': 'import' }
import type { AstNode, ParseProgram } from './source-scan/module-export-names'
import { readExportedNames, resolveRelativeModule } from './source-scan/module-export-names'
import type { MockShape } from './source-scan/mock-factory-reader'
import { createMockReaderContext, readMockFactory } from './source-scan/mock-factory-reader'
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
 *
 * Two things decide whether one of these is noise or a bug, and the guard reports
 * them apart:
 *
 * - A **wholesale** factory replaces the module outright, so a name it does not
 *   list resolves to `undefined` and production throws on first use. The dead key
 *   is inert -- a comment that reads like a stub.
 * - A **partial** factory spreads the genuine module in, so a name it does not
 *   list still resolves to the real export. There, a dead key means the suite has
 *   been exercising production code it believes it stubbed, and the green is
 *   telling you nothing. That is the shape worth waking someone for.
 *
 * Reading the factory is the hard half. Most of the tree does not write an object
 * literal inline: it hands back a shared mock module (`() => mocks.sshPtyProvider`,
 * `async () => (await import('./m')).xMock(await importOriginal())`). An
 * object-literal-only reader skips 29% of the `vi.mock` calls in the tree, and the
 * one dead key that was hiding a real call lived in exactly that gap.
 */

type MockCall = { specifier: string; factory: AstNode | undefined }

/** Every `vi.mock`/`vi.doMock` in a file, paired with the factory expression it was given. */
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
  if (typeof specifier !== 'string' || args.length < 2) {
    return []
  }
  return [{ specifier, factory: args[1] }]
}

describe('dead vi.mock factory keys', () => {
  const repoRoot = resolve(__dirname, '..', '..')
  /** Dead keys in a factory that spreads the real module: the real export answers instead. */
  const leakingOffenders: string[] = []
  /** Dead keys in a factory that replaces the module outright: inert, but a lie in the fixture. */
  const inertOffenders: string[] = []
  const phantomPaths: string[] = []
  const unparseable: string[] = []
  let filesScanned = 0
  let mockCallsSeen = 0
  let mockCallsChecked = 0
  let partialMocksSeen = 0
  let partialMocksChecked = 0
  let factoriesUnreadable = 0

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
    const readerContext = createMockReaderContext(parse)
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
        const reading = readMockFactory(call.factory, file.path, readerContext)
        if (!reading) {
          factoriesUnreadable += 1
          continue
        }
        const shape: MockShape = reading.shape
        if (shape === 'partial') {
          partialMocksSeen += 1
        }
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
        if (shape === 'partial') {
          partialMocksChecked += 1
        }
        const dead = reading.keys.filter((name) => !names.has(name))
        const site = `${file.relativePath}: vi.mock('${call.specifier}')`
        for (const key of dead) {
          // An unresolved spread could be the real module, so `unknown` is graded
          // with `partial`: the guard does not get to assume the safe answer.
          const into = shape === 'wholesale' ? inertOffenders : leakingOffenders
          into.push(`${site} key '${key}'`)
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

  it('reads all but a handful of the factories it finds', () => {
    // The reader resolves 10514 of 10556 factories today. A regression that made it
    // give up would empty the offender lists without failing anything else, so the
    // rate is asserted rather than assumed.
    expect(factoriesUnreadable).toBeLessThan(mockCallsSeen / 20)
  })

  it('reaches the partial mocks, where a dead key is dangerous rather than inert', () => {
    // The population that matters. If this floor ever collapses, the assertion below
    // it is green because nothing was looked at, not because nothing was wrong.
    expect(partialMocksSeen).toBeGreaterThan(800)
    expect(partialMocksChecked).toBeGreaterThan(300)
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

  it('has no dead factory key in a mock that spreads the real module', () => {
    expect(
      leakingOffenders,
      'This vi.mock spreads the real module and then names a key it does not export, so the ' +
        'genuine export is what the code under test received. Whatever this suite believes it ' +
        'stubbed, it did not: treat its green as unproven until the key is corrected.'
    ).toEqual([])
  })

  it('has no factory key that the mocked module does not export', () => {
    expect(
      inertOffenders,
      'This vi.mock key matches no export of that module. The factory replaces the module ' +
        'outright, so nothing reads the key and no test is wrong because of it -- but it reads ' +
        'as a stub that is doing something. Fix the name, point it at the module that exports ' +
        'the symbol, or delete the key.'
    ).toEqual([])
  })
})
