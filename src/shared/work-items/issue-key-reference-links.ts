/** Issue-key prefixes this chat may link (`ENG` in `ENG-123`), each mapped to the URL its
 *  identifier is appended to, such as `https://linear.app/acme/issue/` or `https://acme.atlassian.net/browse/`. */
export type IssueKeyReferences = ReadonlyMap<string, string>

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MarkdownNode[]
}

// Keys are uppercase letters and digits starting with a letter, as Linear team and Jira project keys are.
const ISSUE_KEY_PATTERN = /([A-Z][A-Z0-9_]{0,9})-([1-9][0-9]{0,6})(?![A-Za-z0-9_-])/g
const EXACT_ISSUE_KEY_PATTERN = /^([A-Z][A-Z0-9_]{0,9})-[1-9][0-9]{0,6}$/

// Why: `src/ABC-1`, `v1.ABC-1` and `XYZ-ABC-1` are paths, versions or longer words.
/** True when the match is part of a longer word or path, like `src/ENG-1` or `ABC-ENG-1`. */
function isEmbeddedReference(value: string, index: number): boolean {
  return index > 0 && /[A-Za-z0-9_./-]/.test(value[index - 1] ?? '')
}

/** An mdast link node around one child. */
function issueLink(url: string, child: MarkdownNode): MarkdownNode {
  return { type: 'link', url, title: null, children: [child] }
}

/** Splits a text node into text and issue links for each known key it contains. */
function splitIssueKeyText(value: string, references: IssueKeyReferences): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(ISSUE_KEY_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    const prefix = match[1] ? references.get(match[1]) : undefined
    if (!prefix || isEmbeddedReference(value, index)) {
      continue
    }
    if (index > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, index) })
    }
    parts.push(issueLink(`${prefix}${label}`, { type: 'text', value: label }))
    cursor = index + label.length
  }
  if (cursor === 0) {
    return [{ type: 'text', value }]
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) })
  }
  return parts
}

/** The issue URL when the whole value is one known key, else null. */
function exactReferenceUrl(value: string, references: IssueKeyReferences): string | null {
  const identifier = value.trim()
  const key = EXACT_ISSUE_KEY_PATTERN.exec(identifier)?.[1]
  const prefix = key ? references.get(key) : undefined
  return prefix ? `${prefix}${identifier}` : null
}

/** Turns `KEY-123` into issue links, in place, only for keys in `references`, so `UTF-8` and
 *  `PHP-74` stay text. Inline code that is exactly one reference links too. */
export function linkIssueKeyReferences(node: MarkdownNode, references: IssueKeyReferences): void {
  const insideLink = node.type === 'link' || node.type === 'linkReference' || node.type === 'image'
  if (references.size === 0 || !node.children || insideLink) {
    return
  }
  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Long replies can hold thousands of references; append one by one to stay under V8's argument limit.
      for (const part of splitIssueKeyText(child.value, references)) {
        nextChildren.push(part)
      }
      continue
    }
    if (child.type === 'inlineCode' && child.value !== undefined) {
      const url = exactReferenceUrl(child.value, references)
      nextChildren.push(url ? issueLink(url, child) : child)
      continue
    }
    linkIssueKeyReferences(child, references)
    nextChildren.push(child)
  }
  node.children = nextChildren
}
