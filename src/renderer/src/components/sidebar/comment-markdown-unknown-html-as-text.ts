type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
}

const HTML_TAG_NAME_PATTERN =
  /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/g

const PHRASING_PARENT_TYPES = new Set([
  'paragraph',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'tableCell'
])

function hasUnknownTag(html: string, allowedTagNames: ReadonlySet<string>): boolean {
  for (const match of html.matchAll(HTML_TAG_NAME_PATTERN)) {
    const name = match[1]
    if (name && !allowedTagNames.has(name.toLowerCase())) {
      return true
    }
  }
  return false
}

function replaceUnknownHtml(parent: MarkdownNode, allowedTagNames: ReadonlySet<string>): void {
  const children = parent.children
  if (!children) {
    return
  }
  const isPhrasingParent = PHRASING_PARENT_TYPES.has(parent.type)
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child.type === 'html' && child.value && hasUnknownTag(child.value, allowedTagNames)) {
      const text: MarkdownNode = { type: 'text', value: child.value }
      children[index] = isPhrasingParent ? text : { type: 'paragraph', children: [text] }
    } else {
      replaceUnknownHtml(child, allowedTagNames)
    }
  }
}

/**
 * Shows raw HTML whose tags sanitize would strip (`<se-tabs>`, `<Button />`) as literal text,
 * so prose that mentions a tag keeps it instead of rendering an empty gap.
 */
export function remarkUnknownHtmlAsText(
  allowedTagNames: ReadonlySet<string>
): () => (tree: MarkdownNode) => void {
  return () => (tree) => replaceUnknownHtml(tree, allowedTagNames)
}
