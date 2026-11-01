/**
 * `evt` names in the frame envelope between a components panel's hidden guest and Orca, and the
 * catalog the guest runtime can see. Zod-free so the guest runtime can bundle it. Every message
 * carries the guest's `document` id so nothing crosses a reload.
 */
export const PLUGIN_DECLARATIVE_MESSAGES = {
  /** guest → host, `{ document, revision, tree }` */
  render: 'ui.render',
  /** host → guest, `{ document, revision, callback, args, edit? }`: `revision` is the tree shown. */
  event: 'ui.event',
  /** guest → host, `{ document, revision, message }`: the plugin threw; the last good tree stays. */
  error: 'ui.error',
  /** host → guest, `{ document, revision, accepted, retryAfterMs? }`: whether a render is shown. */
  ack: 'ui.ack',
  /** guest → host, `{ document }`: the runtime is up and waits for `ui.hydrate` to render. */
  ready: 'ui.ready',
  /**
   * host → guest, `{ panel?, visible?, plugin?, workspace?, memory?, retain? }`: persisted state and
   * context; `memory` hands keyed memory atoms to a dev hot reload, `retain` asks for `ui.retain`.
   */
  hydrate: 'ui.hydrate',
  /** host → guest, `{ visible }` */
  visibility: 'ui.visibility',
  /** guest → host, `{ entries: [{ scope, key, version, value }] }`: persisted atoms changed. */
  persist: 'ui.persist',
  /** guest → host, `{ document, entries: [{ key, version, value? }] }`: keyed memory atoms changed. */
  retain: 'ui.retain',
  /** host → guest, `{ document }`: remember every atom's value before `orca plugin shot --act`. */
  snapshot: 'ui.snapshot',
  /** host → guest, `{ document }`: put the atoms back to the last `ui.snapshot`. */
  restore: 'ui.restore'
} as const

/** Grows with the component catalog, so plugins can feature-detect with `ui.catalog`. */
export const PLUGIN_DECLARATIVE_CATALOG_VERSION = 3

/** Each catalog component's prop names, mirrored by the zod catalog (parity-tested). */
export const PLUGIN_DECLARATIVE_COMPONENT_PROPS = {
  Stack: ['gap', 'align'],
  Row: ['gap', 'align', 'justify', 'wrap'],
  Text: ['tone', 'muted', 'size', 'weight', 'truncate'],
  Heading: ['level'],
  Button: ['variant', 'tone', 'size', 'icon', 'tooltip', 'disabled', 'onPress'],
  IconButton: ['icon', 'label', 'tooltip', 'variant', 'tone', 'size', 'disabled', 'onPress'],
  Badge: ['tone'],
  Card: ['title', 'description'],
  List: ['label'],
  ListItem: ['title', 'description', 'icon', 'current', 'disabled', 'onPress'],
  Input: [
    'label',
    'labelHidden',
    'value',
    'defaultValue',
    'placeholder',
    'type',
    'maxLength',
    'invalid',
    'disabled',
    'onChange',
    'onSubmit'
  ],
  Switch: ['label', 'checked', 'defaultChecked', 'disabled', 'onChange'],
  Select: [
    'label',
    'labelHidden',
    'value',
    'defaultValue',
    'placeholder',
    'options',
    'disabled',
    'onChange'
  ],
  Separator: ['orientation'],
  Progress: ['label', 'labelHidden', 'value'],
  Spinner: ['label', 'labelHidden'],
  EmptyState: ['title', 'description', 'icon'],
  Link: ['href', 'onPress'],
  Code: ['block'],
  // Catalog 2 (Orca 1.4.247).
  Textarea: [
    'label',
    'labelHidden',
    'value',
    'defaultValue',
    'placeholder',
    'rows',
    'maxLength',
    'invalid',
    'disabled',
    'onChange',
    'onSubmit'
  ],
  Checkbox: ['label', 'description', 'checked', 'defaultChecked', 'disabled', 'onChange'],
  RadioGroup: [
    'label',
    'labelHidden',
    'value',
    'defaultValue',
    'options',
    'orientation',
    'disabled',
    'onChange'
  ],
  Slider: [
    'label',
    'labelHidden',
    'value',
    'defaultValue',
    'min',
    'max',
    'step',
    'showValue',
    'disabled',
    'onChange'
  ],
  Field: ['label', 'description', 'error', 'required'],
  Tabs: ['label', 'value', 'defaultValue', 'onChange'],
  Tab: ['value', 'label', 'icon', 'disabled'],
  Collapsible: ['title', 'description', 'open', 'defaultOpen', 'disabled', 'onChange'],
  Toolbar: ['label', 'gap'],
  Grid: ['columns', 'minItemWidth', 'gap'],
  Table: [
    'label',
    'columns',
    'rows',
    'sort',
    'selectionMode',
    'selected',
    'defaultSelected',
    'hasMore',
    'loading',
    'emptyText',
    'maxHeight',
    'onSortChange',
    'onSelectionChange',
    'onRowAction',
    'onLoadMore'
  ],
  Tree: [
    'label',
    'items',
    'selected',
    'defaultSelected',
    'expanded',
    'defaultExpanded',
    'maxHeight',
    'onSelect',
    'onToggle',
    'onAction'
  ],
  Markdown: ['content'],
  CodeView: ['code', 'language', 'label', 'lineNumbers', 'wrap', 'maxHeight'],
  Image: ['src', 'alt', 'size', 'fit', 'rounded'],
  KeyValue: ['label', 'items'],
  Callout: ['tone', 'title', 'icon'],
  Skeleton: ['shape', 'lines', 'label'],
  // Catalog 3 (also Orca 1.4.247).
  RelativeTime: ['at', 'format', 'tone', 'muted']
} as const satisfies Record<string, readonly string[]>

export type PluginDeclarativeComponentTag = keyof typeof PLUGIN_DECLARATIVE_COMPONENT_PROPS

/**
 * Controls whose value Orca owns while the person edits, by the prop holding the value and the
 * callback reporting each edit; the runtime tags their renders with the edits they have seen.
 */
export const PLUGIN_DECLARATIVE_VALUE_CONTROLS = {
  Input: { value: 'value', change: 'onChange' },
  Textarea: { value: 'value', change: 'onChange' },
  Switch: { value: 'checked', change: 'onChange' },
  Checkbox: { value: 'checked', change: 'onChange' },
  Select: { value: 'value', change: 'onChange' },
  RadioGroup: { value: 'value', change: 'onChange' },
  Slider: { value: 'value', change: 'onChange' },
  Tabs: { value: 'value', change: 'onChange' },
  Collapsible: { value: 'open', change: 'onChange' },
  Table: { value: 'selected', change: 'onSelectionChange' },
  Tree: { value: 'selected', change: 'onSelect' }
} as const satisfies Partial<
  Record<PluginDeclarativeComponentTag, { value: string; change: string }>
>

const VALUE_CONTROL_BY_TYPE: ReadonlyMap<string, { value: string; change: string }> = new Map(
  Object.entries(PLUGIN_DECLARATIVE_VALUE_CONTROLS)
)

export function pluginDeclarativeValueControl(
  type: string
): { value: string; change: string } | null {
  return VALUE_CONTROL_BY_TYPE.get(type) ?? null
}

/**
 * Wire-only prop on value controls: the newest edit id the guest had processed for that control
 * when it rendered, so the host can tell an echo of typing from a deliberate reset.
 */
export const PLUGIN_DECLARATIVE_EDIT_PROP = '$edit'

/** Event names plugin code may not subscribe to with `on()`: the panel's own wire traffic. */
export function isReservedPluginDeclarativeEvent(name: string): boolean {
  return (
    name.startsWith('ui.') ||
    name.startsWith('editor.') ||
    name === 'ready' ||
    name === 'hello' ||
    name === 'ping' ||
    name === 'pong'
  )
}
