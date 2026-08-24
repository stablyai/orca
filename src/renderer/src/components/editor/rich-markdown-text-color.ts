import { Mark } from '@tiptap/core'
import {
  RICH_MARKDOWN_TEXT_COLORS,
  type RichMarkdownTextColor
} from './rich-markdown-text-color-palette'

export { RICH_MARKDOWN_TEXT_COLORS, type RichMarkdownTextColor }

type RichMarkdownTextColorSource = {
  raw: string
  content: string
  color: RichMarkdownTextColor
  end: number
}

const COLOR_SOURCE_PATTERN = RICH_MARKDOWN_TEXT_COLORS.join('|')
const OPENING_TAG_PATTERN = new RegExp(
  `^<span\\s+data-orca-text-color\\s*=\\s*(["'])(${COLOR_SOURCE_PATTERN})\\1\\s*>`
)
const CLOSING_TAG_PATTERN = /<\/span\s*>/

export function isRichMarkdownTextColor(value: unknown): value is RichMarkdownTextColor {
  return (
    typeof value === 'string' && RICH_MARKDOWN_TEXT_COLORS.includes(value as RichMarkdownTextColor)
  )
}

export function matchRichMarkdownTextColorSource(
  source: string,
  start = 0
): RichMarkdownTextColorSource | null {
  const remaining = source.slice(start)
  const opening = remaining.match(OPENING_TAG_PATTERN)
  if (!opening || !isRichMarkdownTextColor(opening[2])) {
    return null
  }

  const closing = CLOSING_TAG_PATTERN.exec(remaining.slice(opening[0].length))
  if (!closing) {
    return null
  }

  const closingIndex = opening[0].length + closing.index
  const content = remaining.slice(opening[0].length, closingIndex)
  // Raw HTML inside a color mark cannot be represented without changing its source.
  if (content.includes('<')) {
    return null
  }

  const length = closingIndex + closing[0].length
  return {
    raw: remaining.slice(0, length),
    content,
    color: opening[2],
    end: start + length
  }
}

export const RichMarkdownTextColorExtension = Mark.create({
  name: 'richMarkdownTextColor',

  addAttributes() {
    return {
      color: {
        default: null,
        rendered: false
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-orca-text-color]',
        getAttrs: (element: HTMLElement) => {
          const color = element.getAttribute('data-orca-text-color')
          return isRichMarkdownTextColor(color) ? { color } : false
        }
      }
    ]
  },

  renderHTML({ mark }) {
    const color = mark.attrs.color
    return isRichMarkdownTextColor(color)
      ? ['span', { 'data-orca-text-color': color }, 0]
      : ['span', {}, 0]
  },

  markdownTokenName: 'richMarkdownTextColor',
  markdownTokenizer: {
    name: 'richMarkdownTextColor',
    level: 'inline',
    start: '<span',
    tokenize(source, _tokens, lexer) {
      const matched = matchRichMarkdownTextColorSource(source)
      if (!matched) {
        return undefined
      }
      return {
        type: 'richMarkdownTextColor',
        raw: matched.raw,
        color: matched.color,
        tokens: lexer.inlineTokens(matched.content)
      }
    }
  },
  parseMarkdown: (token, helpers) => {
    if (!isRichMarkdownTextColor(token.color)) {
      return []
    }
    return helpers.applyMark('richMarkdownTextColor', helpers.parseInline(token.tokens ?? []), {
      color: token.color
    })
  },
  renderMarkdown: (node, helpers) => {
    const color = node.attrs?.color
    const content = helpers.renderChildren(node)
    return isRichMarkdownTextColor(color)
      ? `<span data-orca-text-color="${color}">${content}</span>`
      : content
  }
})
