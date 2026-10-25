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

function isUnknownTag(name: string | undefined, allowedTagNames: ReadonlySet<string>): boolean {
  return name !== undefined && !allowedTagNames.has(name.toLowerCase())
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function classifyHtml(
  html: string,
  allowedTagNames: ReadonlySet<string>
): 'none' | 'unknown-only' | 'mixed' {
  let hasUnknown = false
  let hasOther = false
  for (const match of html.matchAll(HTML_TAG_NAME_PATTERN)) {
    if (isUnknownTag(match[1], allowedTagNames)) {
      hasUnknown = true
    } else {
      hasOther = true
    }
  }
  return hasUnknown ? (hasOther ? 'mixed' : 'unknown-only') : 'none'
}

function replaceUnknownHtml(parent: MarkdownNode, allowedTagNames: ReadonlySet<string>): void {
  const children = parent.children
  if (!children) {
    return
  }
  const isPhrasingParent = PHRASING_PARENT_TYPES.has(parent.type)
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child.type !== 'html' || !child.value) {
      replaceUnknownHtml(child, allowedTagNames)
      continue
    }
    const kind = classifyHtml(child.value, allowedTagNames)
    if (kind === 'unknown-only') {
      const text: MarkdownNode = { type: 'text', value: child.value }
      children[index] = isPhrasingParent ? text : { type: 'paragraph', children: [text] }
    } else if (kind === 'mixed') {
      // Why: escape only the unknown tags so allowed HTML and comments in the same block render as before.
      child.value = child.value.replace(HTML_TAG_NAME_PATTERN, (match, name?: string) =>
        isUnknownTag(name, allowedTagNames) ? escapeHtmlText(match) : match
      )
    }
  }
}

/**
 * Shows raw HTML tags that sanitize would strip (`<se-tabs>`, `<Button />`) as literal text,
 * so prose that mentions a tag keeps it instead of rendering an empty gap.
 */
export function remarkUnknownHtmlAsText(
  allowedTagNames: ReadonlySet<string>
): () => (tree: MarkdownNode) => void {
  return () => (tree) => replaceUnknownHtml(tree, allowedTagNames)
}
