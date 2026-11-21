import { Node, type AnyExtension, type MarkdownToken } from '@tiptap/core'
import { registerMarkdownLookbehindTokenizerStart } from '../../markdown/source-scanning/markdown-tokenizer-start'
import {
  skipInlineTransportStartScan,
  type RichMarkdownSourceTransport
} from '../document/rich-markdown-source-transport'
import {
  FOOTNOTE_DEF_ATTR,
  FOOTNOTE_DEF_KEY_ATTR,
  FOOTNOTE_REF_ATTR,
  FOOTNOTE_REF_KEY_ATTR,
  exitTrailingEmptyFootnoteParagraph,
  scrollToFootnoteReference,
  unwrapEmptyFootnoteDefinition
} from './rich-markdown-footnote-navigation'
import {
  formatFootnoteDefinitionMarkdown,
  isValidFootnoteIdentifier,
  matchFootnoteDefinitionBlock,
  normalizeFootnoteIdentifier
} from './rich-markdown-footnote-source'

type FootnoteDefinitionToken = {
  type: 'richMarkdownFootnoteDefinition'
  raw: string
  block: true
  identifier: string
  tokens: MarkdownToken[]
}

export function createRichMarkdownFootnoteReference(transport: RichMarkdownSourceTransport) {
  return Node.create({
    name: 'richMarkdownFootnoteReference',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        identifier: { default: '', rendered: false }
      }
    },

    markdownTokenName: 'richMarkdownFootnoteReference',
    markdownTokenizer: {
      name: 'richMarkdownFootnoteReference',
      level: 'inline',
      start: skipInlineTransportStartScan,
      tokenize(source) {
        const matched = transport.match(source, 'footnote-ref')
        if (!matched || !isValidFootnoteIdentifier(matched.value)) {
          return undefined
        }
        return {
          type: 'richMarkdownFootnoteReference',
          raw: matched.raw,
          identifier: matched.value
        }
      }
    },
    parseMarkdown: (token, helpers) => {
      const identifier = 'identifier' in token ? token.identifier : undefined
      if (
        token.type !== 'richMarkdownFootnoteReference' ||
        typeof identifier !== 'string' ||
        !isValidFootnoteIdentifier(identifier)
      ) {
        return []
      }
      return helpers.createNode('richMarkdownFootnoteReference', { identifier })
    },
    renderMarkdown: (node) => `[^${String(node.attrs?.identifier ?? '')}]`,
    renderText: ({ node }) => String(node.attrs.identifier ?? ''),

    parseHTML() {
      return [
        {
          tag: `sup[${FOOTNOTE_REF_ATTR}]`,
          getAttrs: (element: HTMLElement) => {
            const identifier = element.getAttribute(FOOTNOTE_REF_ATTR)
            if (!identifier || !isValidFootnoteIdentifier(identifier)) {
              return false
            }
            return { identifier }
          }
        }
      ]
    },

    renderHTML({ node }) {
      const identifier = String(node.attrs.identifier ?? '')
      return [
        'sup',
        {
          [FOOTNOTE_REF_ATTR]: identifier,
          [FOOTNOTE_REF_KEY_ATTR]: normalizeFootnoteIdentifier(identifier)
        },
        identifier
      ]
    },

    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('sup')
        dom.setAttribute('contenteditable', 'false')
        const label = document.createElement('span')
        label.className = 'rich-markdown-footnote-ref'
        label.setAttribute('role', 'link')
        label.setAttribute('data-actionable', '')
        dom.appendChild(label)

        const sync = (identifier: string): void => {
          dom.setAttribute(FOOTNOTE_REF_ATTR, identifier)
          dom.setAttribute(FOOTNOTE_REF_KEY_ATTR, normalizeFootnoteIdentifier(identifier))
          label.textContent = identifier
          label.setAttribute('aria-label', `[^${identifier}]`)
        }
        sync(String(node.attrs.identifier ?? ''))

        return {
          dom,
          update: (updatedNode) => {
            if (updatedNode.type.name !== 'richMarkdownFootnoteReference') {
              return false
            }
            sync(String(updatedNode.attrs.identifier ?? ''))
            return true
          }
        }
      }
    }
  })
}

export function createRichMarkdownFootnoteDefinition() {
  return Node.create({
    name: 'richMarkdownFootnoteDefinition',
    priority: 1000,
    group: 'block',
    content: 'block+',
    defining: true,

    addAttributes() {
      return {
        identifier: { default: '', rendered: false }
      }
    },

    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => exitTrailingEmptyFootnoteParagraph(editor),
        Backspace: ({ editor }) => unwrapEmptyFootnoteDefinition(editor)
      }
    },

    markdownTokenName: 'richMarkdownFootnoteDefinition',
    markdownTokenizer: {
      name: 'richMarkdownFootnoteDefinition',
      level: 'block',
      start: registerMarkdownLookbehindTokenizerStart(
        '[^',
        (source) => source.search(/(?<=[\n\r]) {0,3}\[\^[^\s[\]]+\]:(?=[ \t]|[\r\n]|$)/),
        1
      ),
      tokenize(src, _tokens, lexer) {
        const matched = matchFootnoteDefinitionBlock(src, 0)
        if (!matched) {
          return undefined
        }
        const bodyTokens = matched.body ? lexer.blockTokens(matched.body) : []
        const defToken: FootnoteDefinitionToken = {
          type: 'richMarkdownFootnoteDefinition',
          raw: matched.raw,
          block: true,
          identifier: matched.identifier,
          tokens: bodyTokens
        }
        return defToken
      }
    },
    parseMarkdown: (token, helpers) => {
      const identifier = 'identifier' in token ? token.identifier : undefined
      if (
        token.type !== 'richMarkdownFootnoteDefinition' ||
        typeof identifier !== 'string' ||
        !isValidFootnoteIdentifier(identifier)
      ) {
        return []
      }
      const children = helpers.parseChildren(token.tokens ?? [])
      return helpers.createNode(
        'richMarkdownFootnoteDefinition',
        { identifier },
        children.length > 0 ? children : [helpers.createNode('paragraph')]
      )
    },
    renderMarkdown: (node, helpers) => {
      const identifier = String(node.attrs?.identifier ?? '')
      const body = helpers.renderChildren(node.content ?? [], '\n\n')
      return formatFootnoteDefinitionMarkdown(identifier, body)
    },

    parseHTML() {
      return [
        {
          tag: `div[${FOOTNOTE_DEF_ATTR}]`,
          getAttrs: (element: HTMLElement) => {
            const identifier = element.getAttribute(FOOTNOTE_DEF_ATTR)
            if (!identifier || !isValidFootnoteIdentifier(identifier)) {
              return false
            }
            return { identifier }
          }
        }
      ]
    },

    renderHTML({ node }) {
      const identifier = String(node.attrs.identifier ?? '')
      return [
        'div',
        {
          class: 'rich-markdown-footnote-def',
          [FOOTNOTE_DEF_ATTR]: identifier,
          [FOOTNOTE_DEF_KEY_ATTR]: normalizeFootnoteIdentifier(identifier)
        },
        0
      ]
    },

    addNodeView() {
      return ({ node, editor }) => {
        const dom = document.createElement('div')
        dom.className = 'rich-markdown-footnote-def'

        const marker = document.createElement('div')
        marker.className = 'rich-markdown-footnote-def-marker'
        marker.setAttribute('contenteditable', 'false')

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'rich-markdown-footnote-def-label'
        marker.appendChild(button)

        const contentDOM = document.createElement('div')
        contentDOM.className = 'rich-markdown-footnote-def-content'

        dom.appendChild(marker)
        dom.appendChild(contentDOM)

        let currentIdentifier = String(node.attrs.identifier ?? '')
        const sync = (identifier: string): void => {
          currentIdentifier = identifier
          dom.setAttribute(FOOTNOTE_DEF_ATTR, identifier)
          dom.setAttribute(FOOTNOTE_DEF_KEY_ATTR, normalizeFootnoteIdentifier(identifier))
          button.textContent = `[^${identifier}]`
        }
        sync(currentIdentifier)

        const handleJumpBack = (event: MouseEvent): void => {
          event.preventDefault()
          event.stopPropagation()
          const editorRoot = dom.closest<HTMLElement>('.rich-markdown-editor') ?? editor.view.dom
          scrollToFootnoteReference(editorRoot, currentIdentifier)
        }
        button.addEventListener('click', handleJumpBack)

        return {
          dom,
          contentDOM,
          update: (updatedNode) => {
            if (updatedNode.type.name !== 'richMarkdownFootnoteDefinition') {
              return false
            }
            sync(String(updatedNode.attrs.identifier ?? ''))
            return true
          },
          stopEvent: (event) =>
            event.target instanceof window.Node && marker.contains(event.target),
          ignoreMutation: (mutation) => {
            if (mutation.type === 'selection') {
              return false
            }
            return mutation.target !== contentDOM && !contentDOM.contains(mutation.target)
          },
          destroy: () => {
            button.removeEventListener('click', handleJumpBack)
          }
        }
      }
    }
  })
}

export function createRichMarkdownFootnoteExtensions(
  transport: RichMarkdownSourceTransport
): AnyExtension[] {
  return [createRichMarkdownFootnoteReference(transport), createRichMarkdownFootnoteDefinition()]
}
