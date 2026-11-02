import type {
  PluginDeclarativeChild,
  PluginDeclarativeNode
} from '../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { pluginDeclarativeGestureId } from '@/components/plugins/declarative/plugin-declarative-gesture-geometry'

/**
 * A control must sit unchanged this long (same place in the tree, same type, label and target, and,
 * tracked by the renderer, the same on-screen rect) before a press on it counts, so a plugin cannot
 * slide one under the pointer just before the click. One rule for every control that grants:
 * Button, IconButton, ListItem, Link, and the links in a Markdown block.
 */
export const PLUGIN_DECLARATIVE_SETTLE_MS = 500

type SettleRecord = { signature: string; since: number }
const GRANTING: ReadonlySet<string> = new Set([
  'Button',
  'IconButton',
  'ListItem',
  'Link',
  'Markdown'
])

export type PluginDeclarativeGestureStability = {
  /** Records every granting control in a newly accepted tree. */
  observe: (tree: PluginDeclarativeNode | null, now: number) => void
  /** True when every control with this gesture id has been settled for the window (one exists). */
  isSettled: (gestureId: string, now: number) => boolean
}

function textOf(children: PluginDeclarativeChild[]): string {
  return children
    .map((child) => (typeof child === 'string' ? child : `<${child.type}>`))
    .join('')
    .slice(0, 256)
}

/** What the person sees and what a press does; any change restarts the settle window. */
function signatureOf(node: PluginDeclarativeNode, path: string): string {
  const props: Record<string, unknown> = node.props
  const visible = ['label', 'title', 'description', 'icon', 'href', 'variant', 'tone', 'content']
    .map((name) => String(props[name] ?? ''))
    .join('\u0000')
  return `${path}\u0001${node.type}\u0001${visible}\u0001${textOf(node.children)}`
}

function callbackOf(node: PluginDeclarativeNode): string | null {
  const props: object = node.props
  const onPress: unknown = 'onPress' in props ? props.onPress : undefined
  const id: unknown =
    typeof onPress === 'object' && onPress !== null && '$callback' in onPress
      ? onPress.$callback
      : null
  return typeof id === 'string' ? id : null
}

/** The id the renderer tracks a granting control under; null for controls that never grant. */
export function pluginDeclarativeGestureIdOf(node: PluginDeclarativeNode): string | null {
  if (!GRANTING.has(node.type)) {
    return null
  }
  if (node.type === 'Link' && node.props.href) {
    return pluginDeclarativeGestureId.href(node.props.href)
  }
  // Its links never grant the guest a gesture; they open only once the block has settled.
  if (node.type === 'Markdown') {
    return pluginDeclarativeGestureId.markdown(node.props.content)
  }
  const callback = callbackOf(node)
  return callback === null ? null : pluginDeclarativeGestureId.callback(callback)
}

export function createPluginDeclarativeGestureStability(): PluginDeclarativeGestureStability {
  let records = new Map<string, SettleRecord & { gestureId: string }>()
  return {
    observe(tree, now) {
      const next = new Map<string, SettleRecord & { gestureId: string }>()
      // Iterative: trees are validated but can still be deep.
      const stack: { node: PluginDeclarativeNode; path: string }[] = tree
        ? [{ node: tree, path: '' }]
        : []
      for (let item = stack.pop(); item; item = stack.pop()) {
        const { node, path } = item
        const gestureId = pluginDeclarativeGestureIdOf(node)
        if (gestureId !== null) {
          const signature = signatureOf(node, path)
          const previous = records.get(path)
          next.set(path, {
            gestureId,
            signature,
            since:
              previous?.signature === signature && previous.gestureId === gestureId
                ? previous.since
                : now
          })
        }
        node.children.forEach((child, index) => {
          if (typeof child !== 'string') {
            stack.push({ node: child, path: `${path}/${child.key ?? `#${index}`}` })
          }
        })
      }
      records = next
    },
    isSettled(gestureId, now) {
      let found = false
      for (const record of records.values()) {
        if (record.gestureId === gestureId) {
          if (now - record.since < PLUGIN_DECLARATIVE_SETTLE_MS) {
            return false
          }
          found = true
        }
      }
      return found
    }
  }
}
