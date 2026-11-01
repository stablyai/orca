import type { PluginDeclarativeChild, PluginDeclarativeNode } from '../plugin-declarative-catalog'
import {
  formatPluginRelativeTime,
  PLUGIN_RELATIVE_TIME_FORMATS
} from '../plugin-declarative-relative-time'

/** One element of the drawn tree, as a test sees it. Actions re-find it by `path`. */
export type TestElement = {
  type: string
  /** The author's `key`, if any (also what `testId` matches). */
  key: string | undefined
  role: string
  /** Accessible name: a control's `label`, a list item's or card's `title`. */
  label: string | undefined
  /** The words a person reads in it. */
  text: string
  props: Record<string, unknown>
  disabled: boolean
  /** Key path from the root; stable across renders while the element stays put. */
  path: string
}

export type TestQuery = {
  type?: string
  role?: string
  text?: string | RegExp
  label?: string | RegExp
  testId?: string
}

const ROLES: Record<string, string> = {
  Stack: 'group',
  Row: 'group',
  Card: 'region',
  Text: 'text',
  Heading: 'heading',
  Button: 'button',
  IconButton: 'button',
  Badge: 'status',
  List: 'list',
  ListItem: 'listitem',
  Input: 'textbox',
  Switch: 'switch',
  Select: 'combobox',
  Separator: 'separator',
  Progress: 'progressbar',
  Spinner: 'status',
  EmptyState: 'group',
  Link: 'link',
  Code: 'code',
  Textarea: 'textbox',
  Checkbox: 'checkbox',
  RadioGroup: 'radiogroup',
  Slider: 'slider',
  Field: 'group',
  Tabs: 'tablist',
  Tab: 'tab',
  Collapsible: 'group',
  Toolbar: 'toolbar',
  Grid: 'group',
  Table: 'grid',
  Tree: 'tree',
  Markdown: 'document',
  CodeView: 'code',
  Image: 'img',
  KeyValue: 'list',
  Callout: 'note',
  Skeleton: 'status',
  RelativeTime: 'time',
  Unsupported: 'unsupported'
}

/** What a relative time reads now, in English, as Orca draws it (`short` unless set). */
function relativeText(at: unknown, format: unknown): string {
  if (typeof at !== 'number') {
    return ''
  }
  const chosen = PLUGIN_RELATIVE_TIME_FORMATS.find((each) => each === format) ?? 'short'
  return formatPluginRelativeTime(at, Date.now(), chosen, 'en')
}

function cellText(cell: unknown): string {
  if (typeof cell === 'object' && cell !== null && 'at' in cell) {
    return relativeText(cell.at, 'format' in cell ? cell.format : undefined)
  }
  return String(cell ?? '')
}

const OWN_TEXT_PROPS = ['title', 'description', 'content', 'code', 'error', 'alt']

/** Words a data component shows: Table cells, Tree item labels, KeyValue pairs. */
function dataText(props: Record<string, unknown>): string[] {
  const words: string[] = []
  const pending: unknown[] = [props.rows, props.items].flatMap((list) =>
    Array.isArray(list) ? list : []
  )
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (typeof next !== 'object' || next === null) {
      continue
    }
    const entry: Record<string, unknown> = { ...next }
    if (typeof entry.cells === 'object' && entry.cells !== null) {
      words.push(...Object.values(entry.cells).map(cellText))
    }
    for (const name of ['label', 'value']) {
      if (entry[name] !== undefined && entry[name] !== null) {
        words.push(String(entry[name]))
      }
    }
    if (Array.isArray(entry.children)) {
      pending.push(...entry.children)
    }
  }
  return words
}

function textOf(node: PluginDeclarativeChild): string {
  if (typeof node === 'string') {
    return node
  }
  const props: Record<string, unknown> = node.props
  const own = OWN_TEXT_PROPS.map((name) => props[name]).filter(
    (value): value is string => typeof value === 'string'
  )
  if (node.type === 'RelativeTime') {
    return relativeText(props.at, props.format)
  }
  // A tab's words are its label; its children are the panel it shows.
  if (node.type === 'Tab') {
    return typeof props.label === 'string' ? props.label : ''
  }
  return [...own, ...dataText(props), ...node.children.map(textOf)].join(' ')
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()

function labelOf(node: PluginDeclarativeNode): string | undefined {
  const props: Record<string, unknown> = node.props
  const label = props.label ?? props.title
  return typeof label === 'string' ? label : undefined
}

function toElement(node: PluginDeclarativeNode, path: string): TestElement {
  const props: Record<string, unknown> = node.props
  const pressable = node.type === 'ListItem' && props.onPress !== undefined
  return {
    type: node.type,
    key: node.key?.startsWith('#') ? undefined : node.key,
    role: pressable ? 'button' : (ROLES[node.type] ?? 'generic'),
    label: labelOf(node),
    text: normalize(textOf(node)),
    props,
    disabled: props.disabled === true,
    path
  }
}

/** Every element in document order. */
export function listElements(tree: PluginDeclarativeNode | null): TestElement[] {
  const out: TestElement[] = []
  const visit = (node: PluginDeclarativeNode, path: string): void => {
    out.push(toElement(node, path))
    node.children.forEach((child, index) => {
      if (typeof child !== 'string') {
        visit(child, `${path}/${child.key ?? `#${index}`}`)
      }
    })
  }
  if (tree) {
    visit(tree, tree.key ?? '#0')
  }
  return out
}

function matches(value: string | undefined, expected: string | RegExp): boolean {
  if (value === undefined) {
    return false
  }
  return typeof expected === 'string'
    ? normalize(value) === normalize(expected)
    : expected.test(value)
}

export function matchesQuery(element: TestElement, query: TestQuery): boolean {
  return (
    (query.type === undefined || element.type === query.type) &&
    (query.role === undefined || element.role === query.role) &&
    (query.text === undefined || matches(element.text, query.text)) &&
    (query.label === undefined || matches(element.label, query.label)) &&
    (query.testId === undefined || element.key === query.testId)
  )
}

/** Drops matches that contain another match: a Row around "Clear done" is not the button. */
export function innermost(elements: TestElement[]): TestElement[] {
  return elements.filter(
    (element) => !elements.some((other) => other.path.startsWith(`${element.path}/`))
  )
}

export function describeQuery(query: TestQuery): string {
  return Object.entries(query)
    .map(
      ([name, value]) =>
        `${name}: ${value instanceof RegExp ? String(value) : JSON.stringify(value)}`
    )
    .join(', ')
}

export type TreeSnapshot = {
  type: string
  key?: string
  props?: Record<string, unknown>
  children?: (TreeSnapshot | string)[]
}

/** The drawn tree as plain data for snapshots: handlers show as `[handler]`, wire ids drop out. */
export function snapshotTree(node: PluginDeclarativeChild): TreeSnapshot | string {
  if (typeof node === 'string') {
    return node
  }
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(node.props)) {
    if (name.startsWith('$')) {
      continue
    }
    const isHandler = typeof value === 'object' && value !== null && '$callback' in value
    props[name] = isHandler ? '[handler]' : value
  }
  return {
    type: node.type,
    ...(node.key && !node.key.startsWith('#') ? { key: node.key } : {}),
    ...(Object.keys(props).length > 0 ? { props } : {}),
    ...(node.children.length > 0 ? { children: node.children.map(snapshotTree) } : {})
  }
}
