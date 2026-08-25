export const GITHUB_ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const

export type GithubAlertType = (typeof GITHUB_ALERT_TYPES)[number]

// GitHub only treats a blockquote as an alert when the first line is exactly
// `[!TYPE]` — a marker followed by inline text on the same line stays a plain
// blockquote, and an unknown type is ignored.
const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\](?=\r?\n|$)/i

type AlertNode = {
  type: string
  value?: string
  children?: AlertNode[]
  data?: {
    hName?: string
    hProperties?: Record<string, unknown>
  }
}

/**
 * Remark plugin that tags GitHub-style alert blockquotes (`> [!NOTE]`) so the
 * renderer can style them. Strips the marker line and attaches a
 * `data-alert-type` attribute plus alert classes to the blockquote. Must run
 * before remark-breaks so the marker and body share one text node.
 */
export function remarkGithubAlerts() {
  return (tree: AlertNode): void => {
    visitBlockquotes(tree, (blockquote) => {
      const type = tagBlockquoteAlert(blockquote)
      if (!type) {
        return
      }
      const data = blockquote.data ?? (blockquote.data = {})
      data.hProperties = {
        ...data.hProperties,
        className: ['markdown-alert', `markdown-alert-${type}`]
      }
    })
  }
}

function tagBlockquoteAlert(blockquote: AlertNode): GithubAlertType | null {
  const firstParagraph = blockquote.children?.[0]
  if (!firstParagraph || firstParagraph.type !== 'paragraph' || !firstParagraph.children) {
    return null
  }
  const firstChild = firstParagraph.children[0]
  if (!firstChild || firstChild.type !== 'text' || typeof firstChild.value !== 'string') {
    return null
  }
  const match = firstChild.value.match(ALERT_MARKER)
  if (!match) {
    return null
  }

  // Drop the marker and the newline that follows it.
  firstChild.value = firstChild.value.slice(match[0].length).replace(/^\r?\n/, '')
  if (firstChild.value === '') {
    firstParagraph.children.shift()
  }
  if (firstParagraph.children.length === 0) {
    blockquote.children!.shift()
  }

  return match[1].toLowerCase() as GithubAlertType
}

function visitBlockquotes(node: AlertNode, visit: (node: AlertNode) => void): void {
  if (node.type === 'blockquote') {
    visit(node)
  }
  for (const child of node.children ?? []) {
    visitBlockquotes(child, visit)
  }
}
