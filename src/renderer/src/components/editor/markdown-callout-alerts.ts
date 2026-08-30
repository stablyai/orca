// Renders GitHub/Obsidian callout blockquotes (`> [!NOTE]`, `> [!WARNING]`, …)
// as styled callout boxes instead of the literal `[!type]` marker. A remark
// (mdast) transform so it runs before sanitize; output is class-only (no inline
// SVG) so it survives rehype-sanitize with a small allowlist. Colors come from
// CSS (markdown-preview.css), monochrome per the styleguide with the one
// semantic accent (destructive) reserved for warning/caution.

export const CALLOUT_ALERT_TYPES = [
  'note',
  'tip',
  'important',
  'warning',
  'caution'
] as const
type CalloutAlertType = (typeof CALLOUT_ALERT_TYPES)[number]

const ALERT_LABELS: Record<CalloutAlertType, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution'
}

// Marker at the very start of the blockquote's first line, e.g. `[!NOTE]` or
// `[!note] Custom title`. Trailing spaces/tabs (not newlines) after `]` are eaten
// so an inline custom title starts clean. Built from CALLOUT_ALERT_TYPES so a new
// type added there cannot drift out of sync with the matcher.
const MARKER_RE = new RegExp(`^\\[!(${CALLOUT_ALERT_TYPES.join('|')})\\][^\\S\\r\\n]*`, 'i')

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

export function remarkCalloutAlerts(): (tree: MarkdownNode) => void {
  return (tree) => transformChildren(tree)
}

function transformChildren(node: MarkdownNode): void {
  if (!node.children) {
    return
  }
  for (const child of node.children) {
    if (child.type === 'blockquote') {
      transformBlockquote(child)
    }
    transformChildren(child)
  }
}

function transformBlockquote(node: MarkdownNode): void {
  const firstPara = node.children?.[0]
  if (!firstPara || firstPara.type !== 'paragraph' || !firstPara.children?.length) {
    return
  }
  const first = firstPara.children[0]
  if (first.type !== 'text' || typeof first.value !== 'string') {
    return
  }
  const match = MARKER_RE.exec(first.value)
  if (!match) {
    return
  }
  const type = match[1].toLowerCase() as CalloutAlertType

  // Drop the `[!type]` marker, keeping any inline custom title that follows it.
  first.value = first.value.slice(match[0].length)

  // The marker line ends at the first line break in the first paragraph. Split
  // there: title inline before it, body after. The break is a `break` node when
  // remark-breaks ran, or a literal `\n` in a text node otherwise — handle both
  // so the transform doesn't depend on plugin ordering.
  const { title: titleInline, body: inlineBody } = splitAtFirstLineBreak(firstPara.children)
  const titleContent = titleInline.filter(
    (child) => !(child.type === 'text' && (child.value ?? '').trim() === '')
  )

  const titleNode: MarkdownNode = {
    type: 'paragraph',
    data: { hProperties: { className: ['md-alert-title'] } },
    children: titleContent.length > 0 ? titleContent : [{ type: 'text', value: ALERT_LABELS[type] }]
  }

  const body: MarkdownNode[] = [
    ...(inlineBody.length > 0 ? [{ type: 'paragraph', children: inlineBody }] : []),
    ...node.children!.slice(1)
  ]

  // role="note" (not "alert") for every type: these are static rendered content,
  // and "alert" is an assertive live region that would interrupt screen readers
  // on each render. Severity is conveyed by the visible title ("Warning"/"Caution").
  node.data = {
    hName: 'div',
    hProperties: { className: ['md-alert', `md-alert-${type}`], role: 'note' }
  }
  node.children = [titleNode, ...body]
}

// Split a paragraph's inline children at the first line break — a `break` node
// (remark-breaks) or the first `\n` inside a text node (no remark-breaks). The
// break itself is dropped; a text node holding the `\n` is split across the two.
function splitAtFirstLineBreak(children: MarkdownNode[]): {
  title: MarkdownNode[]
  body: MarkdownNode[]
} {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child.type === 'break') {
      return { title: children.slice(0, index), body: children.slice(index + 1) }
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      const newlineIndex = child.value.indexOf('\n')
      if (newlineIndex !== -1) {
        const before = child.value.slice(0, newlineIndex)
        const after = child.value.slice(newlineIndex + 1)
        const title = children.slice(0, index)
        if (before) {
          title.push({ type: 'text', value: before })
        }
        const body = after ? [{ type: 'text', value: after }, ...children.slice(index + 1)] : children.slice(index + 1)
        return { title, body }
      }
    }
  }
  return { title: children, body: [] }
}
