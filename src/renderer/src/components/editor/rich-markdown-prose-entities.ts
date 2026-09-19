import { Extension, type JSONContent } from '@tiptap/core'

import {
  escapedCharacterSourceText,
  RICH_MARKDOWN_ESCAPED_CHARACTER_MARK
} from './rich-markdown-escaped-character'

const TAG_OPENING = /^<(?:[a-zA-Z][a-zA-Z0-9-]*|\/[a-zA-Z][a-zA-Z0-9-]*|!|\?)/

type MarkdownTextEncoder = {
  encodeTextForMarkdown?: (text: string, node: JSONContent, parentNode?: JSONContent) => string
}

function isMarkdownTextEncoder(value: unknown): value is MarkdownTextEncoder {
  return typeof value === 'object' && value !== null
}

function escapeMarkdownSyntax(text: string): string {
  return text.replace(/([\\`*_[\]~])/g, '\\$1')
}

/** Keep prose punctuation literal unless its raw form would change Markdown parsing. */
export function encodeProseTextForMarkdown(text: string): string {
  let output = ''
  let lineStart = true
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '<' && TAG_OPENING.test(text.slice(index))) {
      output += '&lt;'
    } else if (character === '>' && lineStart) {
      output += '&gt;'
    } else {
      output += character
    }
    if (character === '\n') {
      lineStart = true
    } else if (lineStart && (character === ' ' || character === '\t')) {
      lineStart = true
    } else {
      lineStart = false
    }
  }
  return escapeMarkdownSyntax(output)
}

/** Restore prose entities after TipTap's serializer has classified code contexts. */
export const RichMarkdownProseEntities = Extension.create({
  name: 'richMarkdownProseEntities',
  priority: 1,

  onBeforeCreate() {
    const managerValue: unknown = this.editor.markdown
    if (!isMarkdownTextEncoder(managerValue)) {
      return
    }
    const base = managerValue.encodeTextForMarkdown
    if (typeof base !== 'function') {
      return
    }
    managerValue.encodeTextForMarkdown = (text, node, parentNode) => {
      if (node.marks?.some((mark) => mark.type === RICH_MARKDOWN_ESCAPED_CHARACTER_MARK)) {
        const insideCode =
          parentNode?.type === 'codeBlock' || node.marks.some((mark) => mark.type === 'code')
        return escapedCharacterSourceText(text, insideCode)
      }
      const encoded = base.call(managerValue, text, node, parentNode)
      const prose = encoded === text ? text : encodeProseTextForMarkdown(text)
      const insideCode =
        parentNode?.type === 'codeBlock' || node.marks?.some((mark) => mark.type === 'code')
      const hasInlineSyntax = parentNode?.content?.some(
        (child) => child.type === 'inlineMath' || child.type === 'rawMarkdownHtmlInline'
      )
      return !insideCode && hasInlineSyntax ? prose.replace(/\$/g, '\\$&') : prose
    }
  }
})
