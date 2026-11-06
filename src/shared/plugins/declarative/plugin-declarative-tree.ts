import { isPluginJsonObject } from '../manifest/plugin-json-object'
import {
  PLUGIN_DECLARATIVE_CATALOG,
  PLUGIN_DECLARATIVE_ICON_SET,
  PLUGIN_DECLARATIVE_INLINE_COMPONENTS,
  PLUGIN_DECLARATIVE_INTERACTIVE_COMPONENTS,
  PLUGIN_DECLARATIVE_SLOT_CHILDREN,
  isPluginDeclarativeComponentName,
  type PluginDeclarativeChild,
  type PluginDeclarativeChildPolicy,
  type PluginDeclarativeComponentName,
  type PluginDeclarativeNode
} from './plugin-declarative-catalog'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'

export type PluginDeclarativeTreeResult =
  | { ok: true; tree: PluginDeclarativeNode | null; nodes: number; warnings: string[] }
  | { ok: false; error: string }

const NODE_KEYS: ReadonlySet<string> = new Set(['type', 'key', 'props', 'children'])
// Why a flat per-node cost: keeps the byte budget meaningful for trees of empty nodes.
const NODE_OVERHEAD_BYTES = 32
// Why a floor per string: otherwise thousands of empty texts per node would be free to validate.
const TEXT_OVERHEAD_BYTES = 8
const UNKNOWN_COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/
const MAX_WARNINGS = 20
/** Each slot child, the policy it needs from its parent, and that parent. */
const SLOT_CHILD_POLICY: ReadonlyMap<string, PluginDeclarativeChildPolicy> = new Map([
  [PLUGIN_DECLARATIVE_SLOT_CHILDREN.items, 'items'],
  [PLUGIN_DECLARATIVE_SLOT_CHILDREN.tabs, 'tabs']
])
const SLOT_PARENT: Record<string, string> = { ListItem: 'List', Tab: 'Tabs' }

function slotChild(policy: PluginDeclarativeChildPolicy): string | undefined {
  return policy === 'items' || policy === 'tabs'
    ? PLUGIN_DECLARATIVE_SLOT_CHILDREN[policy]
    : undefined
}

type Pending = {
  raw: unknown
  depth: number
  parentType: string | null
  policy: PluginDeclarativeChildPolicy
  /** Inside a ListItem with onPress, which must stay the row's only press target. */
  inPressable: boolean
  siblingKeys: Set<string>
  out: PluginDeclarativeChild[]
  path: string
}

class TreeError extends Error {}

function fail(path: string, message: string): never {
  throw new TreeError(`${path}: ${message}`)
}

function readChildren(raw: unknown, path: string): unknown[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    fail(path, 'children must be an array')
  }
  return raw
}

/** Drops unknown or invalid props (with a warning); null when a required prop is missing. */
function readProps(
  type: PluginDeclarativeComponentName,
  raw: Record<string, unknown>,
  warn: (message: string) => void
): Record<string, unknown> | null {
  const shape: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }> =
    PLUGIN_DECLARATIVE_CATALOG[type].props.shape
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue
    }
    if (!Object.hasOwn(shape, name)) {
      warn(`${type}: ignored unknown prop "${name.slice(0, 64)}"`)
      continue
    }
    const parsed = shape[name].safeParse(value)
    if (!parsed.success) {
      warn(`${type}: ignored invalid ${name}`)
      continue
    }
    props[name] = parsed.data
  }
  for (const [name, schema] of Object.entries(shape)) {
    if (!Object.hasOwn(props, name) && !schema.safeParse(undefined).success) {
      warn(`${type}: missing required ${name}; showing a placeholder`)
      return null
    }
  }
  if (typeof props.icon === 'string' && !PLUGIN_DECLARATIVE_ICON_SET.has(props.icon)) {
    warn(`${type}: unknown icon "${props.icon}"; showing a fallback glyph`)
  }
  return props
}

/**
 * Validates an untrusted `ui.render` tree, returning a fresh copy that holds only known fields.
 * Structure and limits reject; unknown props, enum values and components degrade with warnings.
 * Iterative so a hostile depth cannot overflow the host's stack.
 */
export function parsePluginDeclarativeTree(raw: unknown): PluginDeclarativeTreeResult {
  if (raw === null) {
    return { ok: true, tree: null, nodes: 0, warnings: [] }
  }
  const warnings = new Set<string>()
  const warn = (message: string): void => {
    if (warnings.size < MAX_WARNINGS) {
      warnings.add(message)
    }
  }
  const root: PluginDeclarativeChild[] = []
  const stack: Pending[] = [
    {
      raw,
      depth: 1,
      parentType: null,
      policy: 'any',
      inPressable: false,
      siblingKeys: new Set(),
      out: root,
      path: 'tree'
    }
  ]
  let nodes = 0
  let texts = 0
  let bytes = 0
  try {
    for (let next = stack.pop(); next; next = stack.pop()) {
      const { raw: item, depth, parentType, policy, inPressable, siblingKeys, out, path } = next
      if (typeof item === 'string' || typeof item === 'number') {
        if (policy === 'none' || slotChild(policy) || parentType === null) {
          fail(path, `${parentType ?? 'the root'} does not accept text`)
        }
        if (typeof item === 'number' && !Number.isFinite(item)) {
          fail(path, 'numbers must be finite')
        }
        const text = String(item)
        if (text.length > LIMITS.maxTextLength) {
          fail(path, 'text is too long')
        }
        // Text children count toward the node cap like any other child.
        if (nodes + ++texts > LIMITS.maxNodes) {
          fail(path, `more than ${LIMITS.maxNodes} nodes`)
        }
        bytes += TEXT_OVERHEAD_BYTES + text.length
        if (bytes > LIMITS.maxTreeBytes) {
          fail(path, `tree exceeds ${LIMITS.maxTreeBytes} bytes`)
        }
        out.push(text)
        continue
      }
      if (!isPluginJsonObject(item)) {
        fail(path, 'expected a node, string or number')
      }
      const type = item.type
      const known = isPluginDeclarativeComponentName(type)
      if (!known && (typeof type !== 'string' || !UNKNOWN_COMPONENT_NAME.test(type))) {
        fail(path, `invalid component name ${JSON.stringify(String(type)).slice(0, 80)}`)
      }
      if (policy === 'none' || policy === 'text') {
        fail(path, `${parentType} accepts only text`)
      }
      if (policy === 'inline' && known && !PLUGIN_DECLARATIVE_INLINE_COMPONENTS.has(type)) {
        fail(path, `${parentType} accepts only text, Text, Link, Code, Badge and RelativeTime`)
      }
      const slot = slotChild(policy)
      const ownSlot = typeof type === 'string' ? SLOT_CHILD_POLICY.get(type) : undefined
      if (slot !== undefined && type !== slot) {
        fail(path, `${parentType} holds only ${slot}`)
      }
      if (ownSlot !== undefined && ownSlot !== policy) {
        fail(path, `${type} must be a direct child of ${SLOT_PARENT[type] ?? 'its container'}`)
      }
      if (inPressable && PLUGIN_DECLARATIVE_INTERACTIVE_COMPONENTS.has(type)) {
        fail(path, `a ListItem with onPress cannot contain a ${type}`)
      }
      if (++nodes + texts > LIMITS.maxNodes) {
        fail(path, `more than ${LIMITS.maxNodes} nodes`)
      }
      if (depth > LIMITS.maxDepth) {
        fail(path, `deeper than ${LIMITS.maxDepth}`)
      }
      for (const field of Object.keys(item)) {
        if (!NODE_KEYS.has(field)) {
          fail(path, `unknown node field ${field.slice(0, 64)}`)
        }
      }
      const key = item.key
      if (key !== undefined) {
        if (typeof key !== 'string' || key.length > LIMITS.maxLabelLength) {
          fail(path, 'key must be a short string')
        }
        if (siblingKeys.has(key)) {
          fail(path, `duplicate key ${JSON.stringify(key.slice(0, 64))} among siblings`)
        }
        siblingKeys.add(key)
      }
      const keyField = key === undefined ? {} : { key }
      if (!known) {
        warn(`unknown component ${type}; showing a placeholder`)
        out.push({ type: 'Unsupported', ...keyField, props: { name: type }, children: [] })
        bytes += NODE_OVERHEAD_BYTES + type.length
        continue
      }
      const rawProps = item.props ?? {}
      if (!isPluginJsonObject(rawProps) || Object.keys(rawProps).length > LIMITS.maxPropsPerNode) {
        fail(path, 'props must be an object with few fields')
      }
      const props = readProps(type, rawProps, warn)
      if (!props) {
        out.push({ type: 'Unsupported', ...keyField, props: { name: type }, children: [] })
        bytes += NODE_OVERHEAD_BYTES + type.length
        continue
      }
      bytes += NODE_OVERHEAD_BYTES + JSON.stringify(props).length
      if (bytes > LIMITS.maxTreeBytes) {
        fail(path, `tree exceeds ${LIMITS.maxTreeBytes} bytes`)
      }
      const children: PluginDeclarativeChild[] = []
      const node = { type, ...keyField, props, children }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each prop was parsed by its schema in the catalog entry for `type`, and required props are present.
      out.push(node as PluginDeclarativeNode)
      const rawChildren = readChildren(item.children, path)
      if (rawChildren.length > LIMITS.maxNodes) {
        fail(path, `more than ${LIMITS.maxNodes} children`)
      }
      const childKeys = new Set<string>()
      const childInPressable = inPressable || (type === 'ListItem' && props.onPress !== undefined)
      // Reverse push so the stack pops children in document order into `children`.
      for (let index = rawChildren.length - 1; index >= 0; index--) {
        stack.push({
          raw: rawChildren[index],
          depth: depth + 1,
          parentType: type,
          policy: PLUGIN_DECLARATIVE_CATALOG[type].children,
          inPressable: childInPressable,
          siblingKeys: childKeys,
          out: children,
          path: `${path}.children.${index}`
        })
      }
    }
  } catch (error) {
    if (error instanceof TreeError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
  const tree = root[0]
  return typeof tree === 'object'
    ? { ok: true, tree, nodes, warnings: [...warnings] }
    : { ok: false, error: 'tree: expected a node' }
}
