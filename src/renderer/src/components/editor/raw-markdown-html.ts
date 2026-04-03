import { Node, mergeAttributes } from '@tiptap/core'

const INLINE_PLACEHOLDER_PREFIX = '[[ORCA_RAW_HTML_INLINE:'
const BLOCK_PLACEHOLDER_PREFIX = '[[ORCA_RAW_HTML_BLOCK:'
const PLACEHOLDER_SUFFIX = ']]'

const INLINE_HTML_PATTERN = /^<!--[\s\S]*?-->|^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/

function encodeHtmlPayload(raw: string): string {
  return encodeURIComponent(raw)
}

function decodeHtmlPayload(payload: string): string {
  try {
    return decodeURIComponent(payload)
  } catch {
    return ''
  }
}

function createPlaceholder(kind: 'inline' | 'block', raw: string): string {
  const prefix = kind === 'inline' ? INLINE_PLACEHOLDER_PREFIX : BLOCK_PLACEHOLDER_PREFIX
  return `${prefix}${encodeHtmlPayload(raw)}${PLACEHOLDER_SUFFIX}`
}

function matchPlaceholder(
  src: string,
  kind: 'inline' | 'block'
): { placeholder: string; value: string } | null {
  const prefix = kind === 'inline' ? INLINE_PLACEHOLDER_PREFIX : BLOCK_PLACEHOLDER_PREFIX
  if (!src.startsWith(prefix)) {
    return null
  }

  const endIndex = src.indexOf(PLACEHOLDER_SUFFIX, prefix.length)
  if (endIndex === -1) {
    return null
  }

  const placeholder = src.slice(0, endIndex + PLACEHOLDER_SUFFIX.length)
  const payload = src.slice(prefix.length, endIndex)
  return {
    placeholder,
    value: decodeHtmlPayload(payload)
  }
}

function matchInlineHtml(src: string): string | null {
  const match = src.match(INLINE_HTML_PATTERN)
  return match?.[0] ?? null
}

function isEscaped(content: string, index: number): boolean {
  let backslashCount = 0
  for (let i = index - 1; i >= 0 && content[i] === '\\'; i -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function findLineEnd(content: string, start: number): number {
  const newlineIndex = content.indexOf('\n', start)
  return newlineIndex === -1 ? content.length : newlineIndex
}

function isLineOnlyHtml(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('<')) {
    return false
  }

  if (trimmed.startsWith('<!--')) {
    return trimmed.includes('-->')
  }

  return /^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>$/.test(trimmed)
}

function matchBlockHtml(content: string, start: number): string | null {
  const lineEnd = findLineEnd(content, start)
  const line = content.slice(start, lineEnd)
  if (!isLineOnlyHtml(line)) {
    return null
  }

  return line
}

export function encodeRawMarkdownHtmlForRichEditor(content: string): string {
  let index = 0
  let isLineStart = true
  let activeFence: '`' | '~' | null = null
  let activeFenceLength = 0
  let result = ''

  while (index < content.length) {
    const lineRest = content.slice(index)

    if (isLineStart) {
      const fenceMatch = lineRest.match(/^\s*(`{3,}|~{3,})/)
      if (fenceMatch) {
        const fenceChar = fenceMatch[1][0] as '`' | '~'
        const fenceLength = fenceMatch[1].length
        if (activeFence === null) {
          activeFence = fenceChar
          activeFenceLength = fenceLength
        } else if (activeFence === fenceChar && fenceLength >= activeFenceLength) {
          activeFence = null
          activeFenceLength = 0
        }
      }
    }

    if (activeFence) {
      const nextChar = content[index]
      result += nextChar
      isLineStart = nextChar === '\n'
      index += 1
      continue
    }

    if (content[index] === '`') {
      let tickCount = 0
      while (content[index + tickCount] === '`') {
        tickCount += 1
      }

      // Why: the closing backtick sequence must be exactly tickCount backticks,
      // not a longer run. We scan forward to find the first exact match.
      let searchFrom = index + tickCount
      let closingIndex = -1
      while (searchFrom < content.length) {
        const candidate = content.indexOf('`'.repeat(tickCount), searchFrom)
        if (candidate === -1) {
          break
        }
        // Verify the match is exactly tickCount backticks (no extra backtick before/after)
        if (
          (candidate === 0 || content[candidate - 1] !== '`') &&
          content[candidate + tickCount] !== '`'
        ) {
          closingIndex = candidate
          break
        }
        searchFrom = candidate + 1
      }

      if (closingIndex !== -1) {
        const rawSpan = content.slice(index, closingIndex + tickCount)
        result += rawSpan
        isLineStart = rawSpan.endsWith('\n')
        index = closingIndex + tickCount
        continue
      }
    }

    if (isLineStart) {
      const blockHtml = matchBlockHtml(content, index)
      if (blockHtml) {
        result += createPlaceholder('block', blockHtml)
        index += blockHtml.length
        continue
      }
    }

    if (content[index] === '<' && !isEscaped(content, index)) {
      const inlineHtml = matchInlineHtml(content.slice(index))
      if (inlineHtml) {
        result += createPlaceholder('inline', inlineHtml)
        index += inlineHtml.length
        continue
      }
    }

    const nextChar = content[index]
    result += nextChar
    isLineStart = nextChar === '\n'
    index += 1
  }

  return result
}

export const RawMarkdownHtmlInline = Node.create({
  name: 'rawMarkdownHtmlInline',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      value: {
        default: ''
      }
    }
  },

  // Why: converting embedded HTML tags into placeholder tokens before the
  // markdown parser runs keeps marked's built-in paragraph tokenization intact
  // while still letting Orca round-trip the raw markup verbatim.
  markdownTokenName: 'rawMarkdownHtmlInline',
  markdownTokenizer: {
    name: 'rawMarkdownHtmlInline',
    level: 'inline',
    start: INLINE_PLACEHOLDER_PREFIX,
    tokenize(src) {
      const matched = matchPlaceholder(src, 'inline')
      if (!matched) {
        return undefined
      }

      return {
        type: 'rawMarkdownHtmlInline',
        raw: matched.placeholder,
        text: matched.value
      }
    }
  },
  parseMarkdown: (token, helpers) => {
    if (token.type !== 'rawMarkdownHtmlInline') {
      return []
    }

    return helpers.createNode('rawMarkdownHtmlInline', {
      value: typeof token.text === 'string' ? token.text : ''
    })
  },
  renderMarkdown: (node) => (typeof node.attrs?.value === 'string' ? node.attrs.value : ''),

  parseHTML() {
    return [{ tag: 'span[data-raw-markdown-html-inline]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const value = typeof node.attrs.value === 'string' ? node.attrs.value : ''
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-raw-markdown-html-inline': '',
        contenteditable: 'false',
        class: 'raw-markdown-html-inline'
      }),
      value
    ]
  }
})

export const RawMarkdownHtmlBlock = Node.create({
  name: 'rawMarkdownHtmlBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      value: {
        default: ''
      }
    }
  },

  markdownTokenName: 'rawMarkdownHtmlBlock',
  markdownTokenizer: {
    name: 'rawMarkdownHtmlBlock',
    level: 'block',
    start: BLOCK_PLACEHOLDER_PREFIX,
    tokenize(src) {
      const matched = matchPlaceholder(src, 'block')
      if (!matched) {
        return undefined
      }

      return {
        type: 'rawMarkdownHtmlBlock',
        raw: matched.placeholder,
        text: matched.value,
        block: true
      }
    }
  },
  parseMarkdown: (token, helpers) => {
    if (token.type !== 'rawMarkdownHtmlBlock') {
      return []
    }

    return helpers.createNode('rawMarkdownHtmlBlock', {
      value: typeof token.text === 'string' ? token.text : ''
    })
  },
  renderMarkdown: (node) => (typeof node.attrs?.value === 'string' ? node.attrs.value : ''),

  parseHTML() {
    return [{ tag: 'div[data-raw-markdown-html-block]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const value = typeof node.attrs.value === 'string' ? node.attrs.value : ''
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-raw-markdown-html-block': '',
        contenteditable: 'false',
        class: 'raw-markdown-html-block'
      }),
      ['pre', value]
    ]
  }
})
