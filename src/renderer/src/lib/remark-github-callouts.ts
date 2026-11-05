import type { Blockquote, Nodes, Root } from 'mdast'

const GITHUB_CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type GitHubCalloutKind = (typeof GITHUB_CALLOUT_KINDS)[number]

// rehype-sanitize allowlist entry for <blockquote>; without it the attribute is stripped.
export const GITHUB_CALLOUT_SANITIZE_ATTRIBUTE: [string, ...string[]] = [
  'dataCallout',
  ...GITHUB_CALLOUT_KINDS
]
export const GITHUB_CALLOUT_TITLE_SANITIZE_ATTRIBUTE: [string, ...string[]] = [
  'dataCalloutTitle',
  'Insight'
]

// GitHub only reads a marker that has its line to itself: `> [!NOTE] aside` stays a quote.
const GITHUB_CALLOUT_MARKER = /^\[!([a-z]+)\](?:\r?\n|$)/i
const CLAUDE_INSIGHT_MARKER = /^\[!★ Insight\](?:\r?\n|$)/
const CLAUDE_INSIGHT_OPEN_LINE = /^ {0,3}`[ \t]*★[ \t]+Insight[ \t]+─{3,}[ \t]*`[ \t]*$/
const CLAUDE_INSIGHT_CLOSE_LINE = /^ {0,3}`[ \t]*─{3,}[ \t]*`[ \t]*$/
const CLAUDE_INSIGHT_PARTIAL_CLOSE_LINE = /^ {0,3}`[ \t]*─+[ \t]*`?[ \t]*$/
const FENCE_OPEN_LINE = /^ {0,3}(`{3,}|~{3,})/

function matchFenceClose(line: string, fence: string): boolean {
  return new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)
}

export function readGitHubCalloutKind(value: unknown): GitHubCalloutKind | null {
  return GITHUB_CALLOUT_KINDS.find((kind) => kind === value) ?? null
}

export function readGitHubCalloutTitle(value: unknown): string | undefined {
  return value === 'Insight' ? 'Insight' : undefined
}

/** Rewrite Claude Code `★ Insight ─────` ... `─────` blocks into callout blockquotes before parsing. */
export function rewriteClaudeInsightBlocks(source: string, growing = false): string {
  if (!source.includes('★ Insight')) {
    return source
  }

  const lines = source.split('\n')
  let changed = false
  let outerFence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '')
    if (outerFence !== null) {
      if (matchFenceClose(line, outerFence)) {
        outerFence = null
      }
      continue
    }
    const fenceMatch = FENCE_OPEN_LINE.exec(line)
    if (fenceMatch?.[1]) {
      outerFence = fenceMatch[1]
      continue
    }
    if (!CLAUDE_INSIGHT_OPEN_LINE.test(line)) {
      continue
    }

    let innerFence: string | null = null
    let closeIndex = -1
    for (let j = i + 1; j < lines.length; j++) {
      const innerLine = (lines[j] ?? '').replace(/\r$/, '')
      if (innerFence !== null) {
        if (matchFenceClose(innerLine, innerFence)) {
          innerFence = null
        }
        continue
      }
      const innerFenceMatch = FENCE_OPEN_LINE.exec(innerLine)
      if (innerFenceMatch?.[1]) {
        innerFence = innerFenceMatch[1]
        continue
      }
      if (CLAUDE_INSIGHT_CLOSE_LINE.test(innerLine)) {
        closeIndex = j
        break
      }
    }

    if (closeIndex !== -1) {
      lines[i] = '> [!★ Insight]'
      for (let j = i + 1; j < closeIndex; j++) {
        const bodyLine = (lines[j] ?? '').replace(/\r$/, '')
        lines[j] = bodyLine ? `> ${bodyLine}` : '>'
      }
      lines[closeIndex] = ''
      changed = true
      i = closeIndex
    } else if (growing) {
      lines[i] = '> [!★ Insight]'
      let bodyEnd = lines.length
      if (
        bodyEnd > i + 1 &&
        innerFence === null &&
        CLAUDE_INSIGHT_PARTIAL_CLOSE_LINE.test((lines[bodyEnd - 1] ?? '').replace(/\r$/, ''))
      ) {
        lines[bodyEnd - 1] = ''
        bodyEnd -= 1
      }
      for (let j = i + 1; j < bodyEnd; j++) {
        const bodyLine = (lines[j] ?? '').replace(/\r$/, '')
        lines[j] = bodyLine ? `> ${bodyLine}` : '>'
      }
      changed = true
      break
    }
  }

  return changed ? lines.join('\n') : source
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
  const insightMatch = CLAUDE_INSIGHT_MARKER.exec(text.value)
  const match = insightMatch ?? GITHUB_CALLOUT_MARKER.exec(text.value)
  const kind = insightMatch ? 'tip' : readGitHubCalloutKind(match?.[1]?.toLowerCase())
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

  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      dataCallout: kind,
      ...(insightMatch ? { dataCalloutTitle: 'Insight' } : {})
    }
  }
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
