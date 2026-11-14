import type { Blockquote, Nodes } from 'mdast'

const GITHUB_CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type GitHubCalloutKind = (typeof GITHUB_CALLOUT_KINDS)[number]

// rehype-sanitize allowlist entry for <blockquote>; without it the attribute is stripped.
export const GITHUB_CALLOUT_SANITIZE_ATTRIBUTE: [string, ...string[]] = [
  'dataCallout',
  ...GITHUB_CALLOUT_KINDS
]

// GitHub only reads a marker that has its line to itself: `> [!NOTE] aside` stays a quote.
const GITHUB_CALLOUT_MARKER = /^\[!([a-z]+)\](?:\r?\n|$)/i

export function readGitHubCalloutKind(value: unknown): GitHubCalloutKind | null {
  return GITHUB_CALLOUT_KINDS.find((kind) => kind === value) ?? null
}

/** Strips a callout marker from a blockquote and returns its kind, or null when it has none. */
function takeGitHubCalloutMarker(node: Blockquote): GitHubCalloutKind | null {
  const paragraph = node.children[0]
  if (paragraph?.type !== 'paragraph') {
    return null
  }
  const text = paragraph.children[0]
  if (text?.type !== 'text') {
    return null
  }
  const match = GITHUB_CALLOUT_MARKER.exec(text.value)
  const kind = readGitHubCalloutKind(match?.[1]?.toLowerCase())
  if (!match || !kind) {
    return null
  }

  const remainder = text.value.slice(match[0].length)
  if (remainder) {
    text.value = remainder
  } else if (match[0].endsWith('\n') || paragraph.children.length === 1) {
    paragraph.children.shift()
    if (paragraph.children.length === 0) {
      node.children.shift()
    }
  } else {
    // `[!NOTE]*aside*`: an inline sibling shares the marker's line.
    return null
  }
  return kind
}

/** Each GitHub alert (`> [!NOTE]`) in the tree, its marker removed. Desktop and mobile mark them.
 *  Why: must run before remark-breaks, which splits the marker's newline into a break node. */
export function forEachGitHubCallout(
  node: Nodes,
  mark: (quote: Blockquote, kind: GitHubCalloutKind) => void
): void {
  if ('children' in node) {
    node.children.forEach((child) => forEachGitHubCallout(child, mark))
  }
  const kind = node.type === 'blockquote' ? takeGitHubCalloutMarker(node) : null
  if (kind && node.type === 'blockquote') {
    mark(node, kind)
  }
}
