import type { Blockquote, Nodes, Root } from 'mdast'

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

function markGitHubCallout(node: Blockquote): void {
  const paragraph = node.children[0]
  if (paragraph?.type !== 'paragraph') {
    return
  }
  const text = paragraph.children[0]
  if (text?.type !== 'text') {
    return
  }
  const match = GITHUB_CALLOUT_MARKER.exec(text.value)
  const kind = readGitHubCalloutKind(match?.[1]?.toLowerCase())
  if (!match || !kind) {
    return
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
    return
  }

  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataCallout: kind } }
}

function visitGitHubCallouts(node: Nodes): void {
  if ('children' in node) {
    node.children.forEach(visitGitHubCallouts)
  }
  if (node.type === 'blockquote') {
    markGitHubCallout(node)
  }
}

// Why: must run before remark-breaks, which splits the marker's newline into a break node.
export function remarkGitHubCallouts(): (tree: Root) => void {
  return visitGitHubCallouts
}
