import {
  PLUGIN_DECLARATIVE_EDIT_PROP,
  pluginDeclarativeValueControl
} from '../plugin-declarative-message-names'
import { Fragment, isOrcaElement, type OrcaComponent } from './declarative-elements'

export type OrcaWireNode = {
  type: string
  key: string
  props: Record<string, unknown>
  children: (OrcaWireNode | string)[]
}
export type OrcaCallback = (...args: unknown[]) => unknown
export type OrcaEvaluation = { tree: OrcaWireNode | null; callbacks: Map<string, OrcaCallback> }

// Why: a clean error beats a guest stack overflow from a self-rendering component.
const MAX_EVALUATION_DEPTH = 512
// Why 40: a Tree's items nest 16 levels, two JSON levels (array, object) each.
const MAX_PROP_DEPTH = 40
const IGNORED_PROPS: ReadonlySet<string> = new Set([
  'children',
  'ref',
  'key',
  PLUGIN_DECLARATIVE_EDIT_PROP
])

function isCallback(value: unknown): value is OrcaCallback {
  return typeof value === 'function'
}

function describe(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' ? String(value) : typeof value
  }
  return Object.getPrototypeOf(value)?.constructor?.name ?? 'object'
}

/** Throws unless `value` survives a JSON round trip unchanged (what the host can validate). */
export function assertPlainJson(value: unknown, where: string, depth = 0): void {
  if (depth > MAX_PROP_DEPTH) {
    throw new TypeError(`${where} is nested too deeply`)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJson(item, `${where}[${index}]`, depth + 1))
    return
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype === Object.prototype || prototype === null) {
      for (const [name, item] of Object.entries(value)) {
        // An absent optional field (`children: loaded ?? undefined`), as JSON would drop it.
        if (item !== undefined) {
          assertPlainJson(item, `${where}.${name}`, depth + 1)
        }
      }
      return
    }
  }
  throw new TypeError(`${where} must be plain JSON data, not ${describe(value)}`)
}

/** A checked copy without absent (`undefined`) object fields, which the host's schemas refuse. */
function plainJsonCopy(value: unknown, where: string): unknown {
  assertPlainJson(value, where)
  return withoutUndefined(value)
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutUndefined)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const copy: Record<string, unknown> = {}
  for (const [name, item] of Object.entries(value)) {
    if (item !== undefined) {
      copy[name] = withoutUndefined(item)
    }
  }
  return copy
}

function assertUniqueKeys(children: (OrcaWireNode | string)[], parent: string): void {
  const seen = new Set<string>()
  for (const child of children) {
    if (typeof child !== 'string') {
      if (seen.has(child.key)) {
        throw new Error(`duplicate key "${child.key.slice(0, 64)}" among the children of ${parent}`)
      }
      seen.add(child.key)
    }
  }
}

/** 64-bit FNV-1a over two lanes, in base 36: short, stable, regex-safe callback ids. */
function hashId(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x5bd1e995)
  }
  return `c${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`
}

/**
 * Evaluates a component into wire nodes. Every node gets a key (the author's, else its slot index,
 * counting null/false gaps), and every function prop an id derived from the node's key path and the
 * prop name, so the same control keeps the same id across renders.
 */
export function evaluateOrcaTree(
  component: OrcaComponent,
  /** Newest edit id processed per value control's onChange callback. */
  editsSeen: ReadonlyMap<string, number> = new Map()
): OrcaEvaluation {
  const callbacks = new Map<string, OrcaCallback>()

  function callbackId(path: string, prop: string): string {
    const base = hashId(`${path}|${prop}`)
    let id = base
    for (let attempt = 1; callbacks.has(id); attempt++) {
      id = `${base}.${attempt}`
    }
    return id
  }

  function hostNode(
    type: string,
    props: Record<string, unknown>,
    key: string,
    parentPath: string,
    depth: number
  ): OrcaWireNode {
    if (!/^[A-Z]/.test(type)) {
      throw new TypeError(
        `<${type.slice(0, 64)}> is not an Orca component; panels never render DOM`
      )
    }
    const path = `${parentPath}/${key}`
    const wireProps: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(props)) {
      if (IGNORED_PROPS.has(name) || value === undefined) {
        continue
      }
      if (isCallback(value)) {
        const id = callbackId(path, name)
        callbacks.set(id, value)
        wireProps[name] = { $callback: id }
      } else {
        wireProps[name] = plainJsonCopy(value, `<${type}> prop "${name}"`)
      }
    }
    const control = pluginDeclarativeValueControl(type)
    const onChange = control ? wireProps[control.change] : undefined
    if (typeof onChange === 'object' && onChange !== null) {
      // Why: the host keeps typing that this render has not seen yet; see the edit protocol.
      const id = '$callback' in onChange ? onChange.$callback : undefined
      wireProps[PLUGIN_DECLARATIVE_EDIT_PROP] =
        typeof id === 'string' ? (editsSeen.get(id) ?? 0) : 0
    }
    const children: (OrcaWireNode | string)[] = []
    const list = Array.isArray(props.children) ? props.children : [props.children]
    list.forEach((child, index) => emit(child, `#${index}`, '', children, path, depth + 1))
    assertUniqueKeys(children, `<${type}>`)
    return { type, key, props: wireProps, children }
  }

  /** `slot` names an unkeyed node; `scope` prefixes an author key (nested arrays, components). */
  function emit(
    value: unknown,
    slot: string,
    scope: string,
    out: (OrcaWireNode | string)[],
    parentPath: string,
    depth: number
  ): void {
    if (depth > MAX_EVALUATION_DEPTH) {
      throw new Error(`component tree is deeper than ${MAX_EVALUATION_DEPTH}`)
    }
    if (value === null || value === undefined || typeof value === 'boolean') {
      return
    }
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        emit(item, `${slot}.${index}`, `${slot}.`, out, parentPath, depth + 1)
      )
      return
    }
    if (!isOrcaElement(value)) {
      throw new TypeError(`a ${describe(value)} is not a valid child; render a component or text`)
    }
    const { type, props } = value
    const key = value.key === undefined ? slot : `${scope}${value.key}`
    if (type === Fragment) {
      emit(props.children, key, `${key}.`, out, parentPath, depth + 1)
    } else if (typeof type === 'function') {
      // The component's key carries to what it renders.
      emit(type(props), key, `${key}:`, out, parentPath, depth + 1)
    } else if (typeof type === 'string') {
      out.push(hostNode(type, props, key, parentPath, depth))
    } else {
      throw new TypeError('invalid element type; import components from "orca"')
    }
  }

  const root: (OrcaWireNode | string)[] = []
  emit(component({}), '#0', '', root, '', 0)
  const nodes = root.map((child, index) =>
    typeof child === 'string'
      ? { type: 'Text', key: `#text${index}`, props: {}, children: [child] }
      : child
  )
  assertUniqueKeys(nodes, 'the panel')
  const tree =
    nodes.length <= 1
      ? (nodes[0] ?? null)
      : { type: 'Stack', key: '#root', props: {}, children: nodes }
  return { tree, callbacks }
}
