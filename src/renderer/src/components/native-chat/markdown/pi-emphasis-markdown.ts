import type { CommentMarkdownExtension } from '@/components/comment-markdown/CommentMarkdown'

const TONE_ATTRIBUTE = 'dataPiEmphasisTone'
const TOKEN = /(?<!\[)\[\[([^[\]\n]{1,32})\]\](?!\])/g

const STATUS_WORDS = {
  success: ['done', 'passed', 'observed', 'fixed', 'live', 'recommended', 'keep'],
  warning: [
    'needs you',
    'decision',
    'unverified',
    'partial',
    'skipped',
    'in progress',
    'pending',
    'at risk'
  ],
  danger: ['failed', 'blocked', 'broken', 'unsafe', 'costs money', 'destructive', 'irreversible'],
  accent: [
    'brainstorm',
    'investigate',
    'preview',
    'implement',
    'qualify',
    'owned',
    'shared',
    'foreign'
  ],
  neutral: ['inferred', 'new', 'changed', 'optional']
}
const STATUS_TONES = new Map(
  Object.entries(STATUS_WORDS).flatMap(([tone, labels]) =>
    labels.map((label) => [label, tone] as const)
  )
)
const TEXT_EXCLUSIONS = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference'
])

type MarkdownNode = {
  type: string
  value?: string
  data?: { hName?: string; hProperties?: Record<string, string> }
  children?: MarkdownNode[]
}

function splitText(node: MarkdownNode, value: string): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let end = 0
  for (const { 0: token, 1: rawLabel, index } of value.matchAll(TOKEN)) {
    const label = rawLabel.trim()
    const words = label.toLowerCase().split(/[\s:]+/)
    const tone = STATUS_TONES.get(words.slice(0, 2).join(' ')) ?? STATUS_TONES.get(words[0])
    if (!tone) {
      continue
    }
    if (index > end) {
      parts.push({ type: 'text', value: value.slice(end, index) })
    }
    parts.push({
      type: 'text',
      value: label,
      data: { hName: 'span', hProperties: { [TONE_ATTRIBUTE]: tone } }
    })
    end = index + token.length
  }
  if (parts.length === 0) {
    return [node]
  }
  if (end < value.length) {
    parts.push({ type: 'text', value: value.slice(end) })
  }
  return parts
}

function decorateStatusTokens(node: MarkdownNode): void {
  if (!node.children || TEXT_EXCLUSIONS.has(node.type)) {
    return
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && !child.data?.hName && child.value?.includes('[[')) {
      return splitText(child, child.value)
    }
    decorateStatusTokens(child)
    return [child]
  })
}

export function piEmphasisMarkdown(
  extension: CommentMarkdownExtension,
  enabled: boolean
): CommentMarkdownExtension {
  if (!enabled) {
    return extension
  }
  return {
    ...extension,
    remarkPlugins: [...extension.remarkPlugins, () => decorateStatusTokens],
    sanitizeAttributes: {
      ...extension.sanitizeAttributes,
      span: [...(extension.sanitizeAttributes.span ?? []), TONE_ATTRIBUTE]
    }
  }
}
