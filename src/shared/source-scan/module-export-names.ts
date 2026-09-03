import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * The set of names a module actually exports, read from its source.
 *
 * Why source and not a dynamic import: the modules a test mocks are the ones
 * with side effects at import time -- Electron handles, native bindings, a
 * relay socket -- so importing them to enumerate their exports is exactly what
 * the mock existed to avoid.
 */

export type AstNode = {
  type: string
  name?: string
  value?: unknown
  computed?: boolean
  declaration?: AstNode
  declarations?: { id?: { name?: string } }[]
  specifiers?: { exported?: { name?: string; value?: string } }[]
  exported?: { name?: string } | null
  source?: { value?: string }
  id?: { name?: string }
  key?: { name?: string; value?: unknown }
  properties?: AstNode[]
  arguments?: AstNode[]
  callee?: AstNode
  object?: AstNode
  property?: AstNode
  expression?: AstNode
  argument?: AstNode
  /** An array on a Program or BlockStatement, a single node on a concise arrow body. */
  body?: AstNode | AstNode[]
}

export type ParseProgram = (filePath: string) => { body: AstNode[] }

/** Extensions tried for a relative specifier, in resolution order. */
const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx']

/**
 * A relative specifier resolved to a file in the tree, or null.
 *
 * Bare specifiers return null on purpose: a package's exports are not ours to
 * read, and guessing at them would be the wrong kind of confident.
 */
export function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }
  // A `.js` specifier is the TS `node16` spelling of a `.ts` file on disk.
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''))
  if (existsSync(base) && statSync(base).isFile()) {
    return base
  }
  return CANDIDATE_SUFFIXES.map((suffix) => base + suffix).find((path) => existsSync(path)) ?? null
}

export type ModuleExports = {
  names: Set<string>
  /**
   * False when some export could not be enumerated -- an unparseable file, a
   * destructured `export const`, or an `export *` through a package. Callers
   * must skip an incomplete module rather than report its keys as unknown,
   * because a partial set turns every real export it missed into a false
   * accusation.
   */
  complete: boolean
}

function collectDeclarationNames(declaration: AstNode, into: ModuleExports): void {
  if (declaration.type === 'VariableDeclaration') {
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.name) {
        into.names.add(declarator.id.name)
      } else {
        into.complete = false
      }
    }
    return
  }
  if (declaration.id?.name) {
    into.names.add(declaration.id.name)
    return
  }
  into.complete = false
}

/** Follows `export * from './x'` so a barrel reports what it really re-exports. */
export function readExportedNames(
  file: string,
  parse: ParseProgram,
  seen = new Set<string>()
): ModuleExports {
  if (seen.has(file)) {
    return { names: new Set(), complete: true }
  }
  seen.add(file)
  let program: { body: AstNode[] }
  try {
    program = parse(file)
  } catch {
    return { names: new Set(), complete: false }
  }
  const result: ModuleExports = { names: new Set(), complete: true }
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      result.names.add('default')
      continue
    }
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration) {
        collectDeclarationNames(statement.declaration, result)
      }
      for (const specifier of statement.specifiers ?? []) {
        const name = specifier.exported?.name ?? specifier.exported?.value
        if (name) {
          result.names.add(name)
        } else {
          result.complete = false
        }
      }
      continue
    }
    if (statement.type !== 'ExportAllDeclaration') {
      continue
    }
    // `export * as ns from '...'` contributes one name, not the target's set.
    if (statement.exported?.name) {
      result.names.add(statement.exported.name)
      continue
    }
    const target = resolveRelativeModule(file, statement.source?.value ?? '')
    if (!target) {
      result.complete = false
      continue
    }
    const reExported = readExportedNames(target, parse, seen)
    for (const name of reExported.names) {
      result.names.add(name)
    }
    result.complete &&= reExported.complete
  }
  return result
}
