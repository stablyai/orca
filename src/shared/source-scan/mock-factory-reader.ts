import type { AstNode } from './module-export-names'
import { resolveRelativeModule } from './module-export-names'
import type { Env, MockReaderContext, Value } from './mock-factory-scope'
import {
  MAX_DEPTH,
  UNKNOWN,
  collectBindings,
  moduleEnv,
  newEnv,
  returnedExpression,
  statementsOf,
  unwrap
} from './mock-factory-scope'

export type { MockReaderContext } from './mock-factory-scope'
export { createMockReaderContext } from './mock-factory-scope'

/**
 * The keys a `vi.mock` factory declares, and whether the real module shows through.
 *
 * The literal form -- `vi.mock('./x', () => ({ a, b }))` -- is one read. The rest
 * of the tree does not use it: the common shape hands the factory a shared mock
 * module (`() => mocks.sshPtyProvider`, `async () => (await import('./m')).xMock()`),
 * and a reader that only understands object literals sees none of those keys. The
 * one dead key that was hiding a real call lived in exactly that blind spot.
 *
 * So this walks the expression back to the object literal it yields, across
 * modules and through calls, binding the factory's `importOriginal` parameter to
 * the genuine module so a spread of it is recognisable. Every step that cannot be
 * read statically collapses to `unknown`, and an unknown anywhere drops the whole
 * factory: the guard must never name a key it did not actually resolve.
 */

/** `partial` means a spread of the genuine module, so an unlisted name still resolves to production. */
export type MockShape = 'wholesale' | 'partial' | 'unknown'

export type MockFactoryReading = { keys: string[]; shape: MockShape }

function lookupExport(file: string, name: string, ctx: MockReaderContext): Value {
  const key = `${file}#${name}`
  if (ctx.resolving.has(key)) {
    return UNKNOWN
  }
  const env = moduleEnv(file, ctx)
  if (!env) {
    return UNKNOWN
  }
  ctx.resolving.add(key)
  try {
    const direct = lookupLocal(name, env, ctx)
    if (direct.kind !== 'unknown') {
      return direct
    }
    for (const specifier of env.starExports) {
      const target = resolveRelativeModule(file, specifier)
      const reExported = target ? lookupExport(target, name, ctx) : UNKNOWN
      if (reExported.kind !== 'unknown') {
        return reExported
      }
    }
    return UNKNOWN
  } finally {
    ctx.resolving.delete(key)
  }
}

function lookupLocal(name: string, env: Env, ctx: MockReaderContext): Value {
  for (let scope: Env | null = env; scope; scope = scope.parent) {
    const bound = scope.values.get(name)
    if (bound) {
      return bound
    }
    const node = scope.nodes.get(name)
    if (node) {
      return evaluate(node, scope, ctx)
    }
    const imported = scope.imports.get(name)
    if (imported) {
      const target = resolveRelativeModule(scope.file, imported.specifier)
      if (!target) {
        return UNKNOWN
      }
      return imported.imported === '*'
        ? { kind: 'namespace', file: target }
        : lookupExport(target, imported.imported, ctx)
    }
  }
  return UNKNOWN
}

function importedNamespace(node: AstNode, env: Env): Value {
  const source = node.source?.value ?? (node.arguments?.[0]?.value as string | undefined)
  if (typeof source !== 'string') {
    return UNKNOWN
  }
  const target = resolveRelativeModule(env.file, source)
  return target ? { kind: 'namespace', file: target } : UNKNOWN
}

/** True for `vi.importActual` / `vi.requireActual` and their bare-imported spellings. */
function isActualModuleCallee(callee: AstNode | undefined): boolean {
  const name =
    callee?.type === 'MemberExpression' ? callee.property?.name : (callee?.name ?? undefined)
  return name === 'importActual' || name === 'requireActual'
}

function evaluateCall(node: AstNode, env: Env, ctx: MockReaderContext): Value {
  const callee = node.callee
  if (isActualModuleCallee(callee)) {
    return { kind: 'real' }
  }
  // `vi.hoisted(() => ...)` is a pass-through: the value it yields is the binding.
  if (
    callee?.type === 'MemberExpression' &&
    callee.object?.name === 'vi' &&
    callee.property?.name === 'hoisted'
  ) {
    return applyFunction(evaluate(node.arguments?.[0], env, ctx), [], ctx)
  }
  // `(await import('./m')).f()` and `import('./m').then((m) => m.f())` both land here.
  if (callee?.type === 'MemberExpression' && callee.property?.name === 'then') {
    const settled = evaluate(callee.object as AstNode, env, ctx)
    return applyFunction(evaluate(node.arguments?.[0] as AstNode, env, ctx), [settled], ctx)
  }
  const target = evaluate(callee as AstNode, env, ctx)
  if (target.kind === 'realFactory') {
    return { kind: 'real' }
  }
  const args = (node.arguments ?? []).map((argument) => evaluate(argument, env, ctx))
  return applyFunction(target, args, ctx)
}

function applyFunction(target: Value, args: Value[], ctx: MockReaderContext): Value {
  if (target.kind !== 'function') {
    return UNKNOWN
  }
  const child = newEnv(target.env.file, target.env)
  const parameters = target.node.params ?? []
  parameters.forEach((parameter, index) => {
    if (parameter.type === 'Identifier' && parameter.name) {
      child.values.set(parameter.name, args[index] ?? UNKNOWN)
    }
  })
  const body = Array.isArray(target.node.body) ? undefined : target.node.body
  if (body?.type === 'BlockStatement') {
    collectBindings(statementsOf(body.body), child)
  }
  const returned = returnedExpression(target.node)
  return returned ? evaluate(returned, child, ctx) : UNKNOWN
}

function evaluateMember(node: AstNode, env: Env, ctx: MockReaderContext): Value {
  const name = node.computed ? undefined : node.property?.name
  if (!name) {
    return UNKNOWN
  }
  const object = evaluate(node.object as AstNode, env, ctx)
  if (object.kind === 'namespace') {
    return lookupExport(object.file, name, ctx)
  }
  return object.kind === 'object' ? propertyOf(object, name, ctx) : UNKNOWN
}

/** A property of a resolved object literal, following spreads so a merged shape reads. */
function propertyOf(
  object: { kind: 'object'; node: AstNode; env: Env },
  name: string,
  ctx: MockReaderContext
): Value {
  const properties = (object.node.properties ?? []).toReversed()
  for (const property of properties) {
    if (property.type === 'SpreadElement') {
      const source = evaluate(property.argument as AstNode, object.env, ctx)
      const found = source.kind === 'object' ? propertyOf(source, name, ctx) : UNKNOWN
      if (found.kind !== 'unknown') {
        return found
      }
      continue
    }
    const key = property.computed ? undefined : (property.key?.name ?? property.key?.value)
    if (key === name) {
      return evaluate(property.value as AstNode, object.env, ctx)
    }
  }
  return UNKNOWN
}

function evaluate(node: AstNode | undefined, env: Env, ctx: MockReaderContext): Value {
  const current = unwrap(node)
  if (!current || ctx.depth > MAX_DEPTH) {
    return UNKNOWN
  }
  ctx.depth += 1
  try {
    switch (current.type) {
      case 'ObjectExpression':
        return { kind: 'object', node: current, env }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration':
        return { kind: 'function', node: current, env }
      case 'Identifier':
        return current.name ? lookupLocal(current.name, env, ctx) : UNKNOWN
      case 'MemberExpression':
        return evaluateMember(current, env, ctx)
      case 'ImportExpression':
        return importedNamespace(current, env)
      case 'CallExpression':
        return evaluateCall(current, env, ctx)
      default:
        return UNKNOWN
    }
  } finally {
    ctx.depth -= 1
  }
}

/** Every declared key of a resolved object, plus whether the genuine module spreads in. */
function readObjectKeys(
  object: { kind: 'object'; node: AstNode; env: Env },
  ctx: MockReaderContext,
  seen: Set<AstNode>
): MockFactoryReading | null {
  if (seen.has(object.node)) {
    return null
  }
  seen.add(object.node)
  const keys: string[] = []
  let shape: MockShape = 'wholesale'
  for (const property of object.node.properties ?? []) {
    if (property.type !== 'SpreadElement') {
      const key = property.computed ? undefined : (property.key?.name ?? property.key?.value)
      if (typeof key !== 'string') {
        return null
      }
      keys.push(key)
      continue
    }
    const source = evaluate(property.argument as AstNode, object.env, ctx)
    if (source.kind === 'real') {
      shape = 'partial'
      continue
    }
    if (source.kind !== 'object') {
      // An unreadable spread could be the real module, so the shape is not settled;
      // the named keys are still the named keys.
      shape = shape === 'partial' ? 'partial' : 'unknown'
      continue
    }
    const nested = readObjectKeys(source, ctx, seen)
    if (!nested) {
      return null
    }
    keys.push(...nested.keys)
    shape = nested.shape === 'partial' || shape === 'partial' ? 'partial' : shape
  }
  return { keys, shape }
}

/**
 * The keys a `vi.mock` factory declares for `file`, or null when it cannot be read.
 *
 * `importOriginal` is bound before evaluation so the partial form -- the one where
 * a dead key is dangerous rather than merely inert -- resolves to `partial`.
 */
export function readMockFactory(
  factory: AstNode | undefined,
  file: string,
  ctx: MockReaderContext
): MockFactoryReading | null {
  const env = moduleEnv(file, ctx)
  if (!env) {
    return null
  }
  const node = unwrap(factory)
  if (!node) {
    return null
  }
  const isFunction =
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  const value = isFunction
    ? applyFunction({ kind: 'function', node, env }, [{ kind: 'realFactory' }], ctx)
    : evaluate(node, env, ctx)
  return value.kind === 'object' ? readObjectKeys(value, ctx, new Set()) : null
}
