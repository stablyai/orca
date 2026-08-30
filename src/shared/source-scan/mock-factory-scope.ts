import type { AstNode, ParseProgram } from './module-export-names'

/**
 * What a name means inside a `vi.mock` factory, and where to look it up.
 *
 * Reading a factory means walking back through the bindings between it and the
 * object literal it yields -- imports, `vi.hoisted` results, destructured shared
 * mock modules, function parameters. This is the scope machinery that walk needs;
 * `mock-factory-reader` is the walk itself.
 */

export type Value =
  | { kind: 'object'; node: AstNode; env: Env }
  | { kind: 'function'; node: AstNode; env: Env }
  | { kind: 'namespace'; file: string }
  /** The genuine module, from `importOriginal()` / `vi.importActual()`. */
  | { kind: 'real' }
  /** `importOriginal` itself: calling it yields the genuine module. */
  | { kind: 'realFactory' }
  | { kind: 'unknown' }

export type ImportRef = { specifier: string; imported: string }

export type Env = {
  file: string
  nodes: Map<string, AstNode>
  imports: Map<string, ImportRef>
  values: Map<string, Value>
  starExports: string[]
  parent: Env | null
}

export type MockReaderContext = {
  parse: ParseProgram
  moduleEnvs: Map<string, Env | null>
  resolving: Set<string>
  depth: number
}

export const UNKNOWN: Value = { kind: 'unknown' }
export const MAX_DEPTH = 24

const TRANSPARENT = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'ParenthesizedExpression',
  'AwaitExpression'
])

export function createMockReaderContext(parse: ParseProgram): MockReaderContext {
  return { parse, moduleEnvs: new Map(), resolving: new Set(), depth: 0 }
}

export function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node
  while (current && TRANSPARENT.has(current.type)) {
    current = current.expression ?? current.argument
  }
  return current
}

export function statementsOf(node: AstNode | AstNode[] | undefined): AstNode[] {
  return Array.isArray(node) ? node : []
}

/**
 * The single expression a function yields, or undefined.
 *
 * More than one `return` means the answer depends on arguments this reader does
 * not evaluate, so the function is treated as unreadable rather than guessed at.
 */
export function returnedExpression(fn: AstNode): AstNode | undefined {
  const body = Array.isArray(fn.body) ? undefined : fn.body
  if (body?.type !== 'BlockStatement') {
    return unwrap(body)
  }
  const returns: AstNode[] = []
  const stack: unknown[] = [statementsOf(body.body)]
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
    // A nested function's `return` is its own, not this one's.
    if (candidate.type === 'ArrowFunctionExpression' || candidate.type === 'FunctionExpression') {
      continue
    }
    if (candidate.type === 'ReturnStatement') {
      returns.push(candidate)
      continue
    }
    stack.push(...Object.values(candidate as Record<string, unknown>))
  }
  return returns.length === 1 ? unwrap(returns[0]?.argument) : undefined
}

export function newEnv(file: string, parent: Env | null): Env {
  return { file, nodes: new Map(), imports: new Map(), values: new Map(), starExports: [], parent }
}

export function bindImport(statement: AstNode, env: Env): void {
  const specifier = statement.source?.value
  if (typeof specifier !== 'string') {
    return
  }
  for (const entry of statement.specifiers ?? []) {
    const node = entry as unknown as AstNode
    const local = node.local?.name ?? node.exported?.name
    if (!local) {
      continue
    }
    const imported =
      node.type === 'ImportDefaultSpecifier'
        ? 'default'
        : node.type === 'ImportNamespaceSpecifier'
          ? '*'
          : (node.imported?.name ?? node.imported?.value ?? node.local?.name)
    if (typeof imported === 'string') {
      env.imports.set(local, { specifier, imported })
    }
  }
}

/**
 * `const x = e` and `const { a, b: c } = e`, the latter as a member read of `e`.
 *
 * The destructured form is how a test reaches a shared mock module
 * (`const { createSshIpcMocks } = await import('./m')`), so skipping it would
 * leave the guard blind to every factory built that way.
 */
export function bindDeclarator(id: AstNode | undefined, init: AstNode | undefined, env: Env): void {
  if (!id || !init) {
    return
  }
  if (id.type === 'Identifier' && id.name) {
    env.nodes.set(id.name, init)
    return
  }
  if (id.type !== 'ObjectPattern') {
    return
  }
  for (const property of id.properties ?? []) {
    const key = property.computed ? undefined : (property.key?.name ?? property.key?.value)
    const local = (property.value as AstNode | undefined)?.name
    if (typeof key !== 'string' || !local) {
      continue
    }
    env.nodes.set(local, {
      type: 'MemberExpression',
      object: init,
      property: { type: 'Identifier', name: key },
      computed: false
    })
  }
}

/** Top-level or block-level `const`/`function`/`import` bindings, by name. */
export function collectBindings(statements: AstNode[], env: Env): void {
  for (const statement of statements) {
    if (statement.type === 'ImportDeclaration') {
      bindImport(statement, env)
      continue
    }
    if (statement.type === 'ExportAllDeclaration' && !statement.exported?.name) {
      const specifier = statement.source?.value
      if (typeof specifier === 'string') {
        env.starExports.push(specifier)
      }
      continue
    }
    if (statement.type === 'ExportNamedDeclaration' && statement.source?.value) {
      bindImport(statement, env)
      continue
    }
    const declared = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (!declared) {
      continue
    }
    if (declared.type === 'VariableDeclaration') {
      for (const declarator of declared.declarations ?? []) {
        const entry = declarator as { id?: AstNode; init?: AstNode }
        bindDeclarator(entry.id, entry.init, env)
      }
      continue
    }
    if (declared.type === 'FunctionDeclaration' && declared.id?.name) {
      env.nodes.set(declared.id.name, declared)
    }
  }
}

export function moduleEnv(file: string, ctx: MockReaderContext): Env | null {
  const cached = ctx.moduleEnvs.get(file)
  if (cached !== undefined) {
    return cached
  }
  let env: Env | null = null
  try {
    const program = ctx.parse(file)
    env = newEnv(file, null)
    collectBindings(program.body, env)
  } catch {
    env = null
  }
  ctx.moduleEnvs.set(file, env)
  return env
}
