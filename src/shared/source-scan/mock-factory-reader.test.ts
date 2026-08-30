import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { parseAst as ParseAstFn } from 'vite' with { 'resolution-mode': 'import' }
import type { AstNode, ParseProgram } from './module-export-names'
import { createMockReaderContext, readMockFactory } from './mock-factory-reader'
import type { MockFactoryReading } from './mock-factory-reader'

let parseAst: typeof ParseAstFn

beforeAll(async () => {
  ;({ parseAst } = await import('vite'))
})

/**
 * The reader decides whether a `vi.mock` key is checked at all, so a regression
 * here is silent: the guard reports an empty list and everyone reads that as
 * clean. Each case below is a factory shape that actually appears in the tree,
 * plus the shapes that must fail closed rather than be guessed at.
 */

let workspace: string | null = null

afterEach(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true })
    workspace = null
  }
})

/** Reads the first `vi.mock` factory in `entry`, with `files` on disk beside it. */
function read(files: Record<string, string>, entry = 'suite.test.ts'): MockFactoryReading | null {
  workspace = mkdtempSync(join(tmpdir(), 'mock-factory-'))
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(workspace, name), source)
  }
  const parse: ParseProgram = (file) =>
    parseAst(readFileSync(file, 'utf8'), {
      lang: file.endsWith('.tsx') ? 'tsx' : 'ts'
    }) as unknown as { body: AstNode[] }
  const entryPath = join(workspace, entry)
  const program = parse(entryPath)
  let factory: AstNode | undefined
  const stack: unknown[] = [program]
  while (stack.length > 0 && !factory) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') {
      continue
    }
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    const candidate = node as AstNode
    if (
      candidate.type === 'CallExpression' &&
      candidate.callee?.type === 'MemberExpression' &&
      candidate.callee.object?.name === 'vi' &&
      candidate.callee.property?.name === 'mock'
    ) {
      factory = candidate.arguments?.[1]
      break
    }
    stack.push(...Object.values(candidate as Record<string, unknown>))
  }
  return readMockFactory(factory, entryPath, createMockReaderContext(parse))
}

describe('readMockFactory', () => {
  it('reads an inline object literal', () => {
    expect(read({ 'suite.test.ts': `vi.mock('./x', () => ({ a: 1, b: 2 }))` })).toEqual({
      keys: ['a', 'b'],
      shape: 'wholesale'
    })
  })

  it('reads a factory that hands back a property of a shared mock module', () => {
    // The shape that hid the one dead key a real call was reaching through: the
    // factory returns an identifier, so an object-literal-only reader sees nothing.
    const reading = read({
      'mocks.ts': [
        `export function createMocks() {`,
        `  const state = { helper: 1 }`,
        `  const modules = { provider: { Live: class {}, gone: () => false } }`,
        `  return { ...state, ...modules }`,
        `}`
      ].join('\n'),
      'suite.test.ts': [
        `const mocks = await vi.hoisted(async () => {`,
        `  const { createMocks } = await import('./mocks')`,
        `  return createMocks()`,
        `})`,
        `vi.mock('./provider', () => mocks.provider)`
      ].join('\n')
    })
    expect(reading).toEqual({ keys: ['Live', 'gone'], shape: 'wholesale' })
  })

  it('reads a factory that calls an imported builder', () => {
    expect(
      read({
        'registry.ts': `export const ptyMock = () => ({ spawn: 1 })`,
        'suite.test.ts': `vi.mock('./pty', async () => (await import('./registry')).ptyMock())`
      })
    ).toEqual({ keys: ['spawn'], shape: 'wholesale' })
  })

  it('reads a factory built through a then-callback', () => {
    expect(
      read({
        'registry.ts': `export const wslMock = () => ({ runWsl: 1 })`,
        'suite.test.ts': `vi.mock('./wsl', () => import('./registry').then((m) => m.wslMock()))`
      })
    ).toEqual({ keys: ['runWsl'], shape: 'wholesale' })
  })

  it('calls a spread of importOriginal partial, not wholesale', () => {
    // The distinction the guard reports on: here an unlisted name still resolves
    // to the genuine export, so a dead key means production ran.
    expect(
      read({
        'suite.test.ts': `vi.mock('./x', async (importOriginal) => ({ ...(await importOriginal()), a: 1 }))`
      })
    ).toEqual({ keys: ['a'], shape: 'partial' })
  })

  it('carries partial through a builder that spreads its argument', () => {
    expect(
      read({
        'registry.ts': `export function build(actual) { return { ...actual, sampled: 1 } }`,
        'suite.test.ts': [
          `vi.mock('./x', async (importOriginal) => {`,
          `  const { build } = await import('./registry')`,
          `  return build(await importOriginal())`,
          `})`
        ].join('\n')
      })
    ).toEqual({ keys: ['sampled'], shape: 'partial' })
  })

  it('calls a spread of vi.importActual partial', () => {
    expect(
      read({
        'suite.test.ts': `vi.mock('./x', async () => ({ ...(await vi.importActual('./x')), a: 1 }))`
      })
    ).toEqual({ keys: ['a'], shape: 'partial' })
  })

  it('reports an unreadable spread as unknown rather than assuming wholesale', () => {
    // Grading this `wholesale` would let a real partial mock be reported as noise.
    expect(read({ 'suite.test.ts': `vi.mock('./x', () => ({ ...whatever, a: 1 }))` })).toEqual({
      keys: ['a'],
      shape: 'unknown'
    })
  })

  it('gives up on a computed key rather than naming a key it did not read', () => {
    expect(read({ 'suite.test.ts': `vi.mock('./x', () => ({ [name]: 1 }))` })).toBeNull()
  })

  it('gives up when the factory returns an identifier it cannot resolve', () => {
    expect(read({ 'suite.test.ts': `vi.mock('./x', () => somethingElse)` })).toBeNull()
  })

  it('gives up on a builder whose result depends on which branch returned', () => {
    expect(
      read({
        'registry.ts': `export function build(flag) { if (flag) { return { a: 1 } } return { b: 2 } }`,
        'suite.test.ts': `vi.mock('./x', async () => (await import('./registry')).build(true))`
      })
    ).toBeNull()
  })
})
