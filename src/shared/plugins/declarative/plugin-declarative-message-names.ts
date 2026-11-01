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
  /** host → guest, `{ panel?, visible?, plugin?, workspace? }`: persisted state and context. */
  hydrate: 'ui.hydrate',
  /** host → guest, `{ visible }` */
  visibility: 'ui.visibility',
  /** guest → host, `{ entries: [{ scope, key, version, value }] }`: persisted atoms changed. */
  persist: 'ui.persist'
} as const

/** Grows with the component catalog, so plugins can feature-detect with `ui.catalog`. */
export const PLUGIN_DECLARATIVE_CATALOG_VERSION = 1

/** Each catalog component's prop names, mirrored by the zod catalog (parity-tested). */
export const PLUGIN_DECLARATIVE_COMPONENT_PROPS = {
  Stack: ['gap', 'align'],
  Row: ['gap', 'align', 'justify', 'wrap'],
  Text: ['tone', 'muted', 'size', 'weight', 'truncate'],
  Heading: ['level'],
  Button: ['variant', 'tone', 'size', 'icon', 'disabled', 'onPress'],
  IconButton: ['icon', 'label', 'variant', 'tone', 'size', 'disabled', 'onPress'],
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
  Code: ['block']
} as const satisfies Record<string, readonly string[]>

export type PluginDeclarativeComponentTag = keyof typeof PLUGIN_DECLARATIVE_COMPONENT_PROPS

/** Controls whose value Orca owns while the person edits; the runtime tags their renders. */
export const PLUGIN_DECLARATIVE_VALUE_CONTROLS: readonly PluginDeclarativeComponentTag[] = [
  'Input',
  'Switch',
  'Select'
]

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
