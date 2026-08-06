import { Node } from '@tiptap/core'
import type { RichMarkdownSourceTransport } from './rich-markdown-source-transport'
import {
  HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT,
  parseHtmlSuperscriptLinkSource,
  type HtmlSuperscriptLinkSource
} from './rich-markdown-html-superscript-link-source'
import { projectMarkdownHrefForClipboard } from './markdown-internal-links'
import {
  classifyHtmlSuperscriptLinkAction,
  type RichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'
import { translate } from '@/i18n/i18n'

const CLIPBOARD_VERSION = '1'
const MARKER_ATTRIBUTE = 'data-rich-markdown-html-superscript-link'
const SOURCE_ATTRIBUTE = 'data-orca-superscript-link-source'
const clipboardEncoder = new TextEncoder()

export function createRichMarkdownHtmlSuperscriptLink(
  transport: RichMarkdownSourceTransport,
  context: RichMarkdownHtmlSuperscriptLinkContext
) {
  return Node.create({
    name: 'richMarkdownHtmlSuperscriptLink',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        source: { default: '', rendered: false },
        href: { default: '', rendered: false },
        label: { default: '', rendered: false },
        title: { default: null, rendered: false }
      }
    },

    markdownTokenName: 'richMarkdownHtmlSuperscriptLink',
    markdownTokenizer: {
      name: 'richMarkdownHtmlSuperscriptLink',
      level: 'inline',
      start: transport.startFor('html-superscript-link'),
      tokenize(source) {
        const matched = transport.match(source, 'html-superscript-link')
        if (!matched) {
          return undefined
        }
        const parsed = parseStructuredPayload(matched.value)
        if (!parsed) {
          return undefined
        }
        return {
          type: 'richMarkdownHtmlSuperscriptLink',
          raw: matched.raw,
          citation: parsed
        }
      }
    },
    parseMarkdown: (token, helpers) => {
      const citation = (token as { citation?: HtmlSuperscriptLinkSource }).citation
      if (token.type !== 'richMarkdownHtmlSuperscriptLink' || !citation) {
        return []
      }
      return helpers.createNode('richMarkdownHtmlSuperscriptLink', citation)
    },
    renderMarkdown: (node) => String(node.attrs?.source ?? ''),
    renderText: ({ node }) => String(node.attrs.label ?? ''),

    parseHTML() {
      return [
        {
          tag: `sup[${MARKER_ATTRIBUTE}]`,
          getAttrs: (element: HTMLElement) => validateClipboardElement(element)
        }
      ]
    },

    renderHTML({ node }) {
      const citation = node.attrs as HtmlSuperscriptLinkSource
      const projectedHref = projectMarkdownHrefForClipboard(citation.href)
      const anchorAttributes: Record<string, string> = {}
      if (projectedHref !== null) {
        anchorAttributes.href = projectedHref
      }
      if (citation.title !== null) {
        anchorAttributes.title = citation.title
      }
      return [
        'sup',
        {
          [MARKER_ATTRIBUTE]: CLIPBOARD_VERSION,
          [SOURCE_ATTRIBUTE]: citation.source
        },
        ['a', anchorAttributes, citation.label]
      ]
    },

    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('sup')
        dom.setAttribute(MARKER_ATTRIBUTE, '')
        dom.setAttribute('contenteditable', 'false')
        const label = document.createElement('span')
        label.className = 'rich-markdown-html-superscript-link'
        label.textContent = String(node.attrs.label ?? '')
        dom.appendChild(label)

        const updateActionability = (): void => {
          const href = String(node.attrs.href ?? '')
          const actionable = classifyHtmlSuperscriptLinkAction(href, context.getSnapshot())
          label.setAttribute(
            'aria-label',
            actionable
              ? translate(
                  'auto.components.editor.richMarkdownHtmlSuperscriptLink.availableAriaLabel',
                  '{{value0}}, link to {{value1}}',
                  { value0: String(node.attrs.label ?? ''), value1: href }
                )
              : translate(
                  'auto.components.editor.richMarkdownHtmlSuperscriptLink.unavailableAriaLabel',
                  '{{value0}}, citation link unavailable',
                  { value0: String(node.attrs.label ?? '') }
                )
          )
          if (actionable) {
            label.setAttribute('role', 'link')
          } else {
            label.removeAttribute('role')
          }
          label.toggleAttribute('data-actionable', actionable)
        }
        updateActionability()
        const unsubscribe = context.subscribe(updateActionability)
        return { dom, destroy: unsubscribe }
      }
    }
  })
}

function parseStructuredPayload(value: string): HtmlSuperscriptLinkSource | null {
  let candidate: unknown
  try {
    candidate = JSON.parse(value)
  } catch {
    return null
  }
  if (!isCitationShape(candidate)) {
    return null
  }
  const parsed = parseHtmlSuperscriptLinkSource(candidate.source)
  return parsed && sameCitation(parsed, candidate) ? parsed : null
}

function validateClipboardElement(element: HTMLElement): false | Record<string, unknown> {
  if (
    element.getAttribute(MARKER_ATTRIBUTE) !== CLIPBOARD_VERSION ||
    !hasOnlyAttributes(element, [MARKER_ATTRIBUTE, SOURCE_ATTRIBUTE, 'data-pm-slice'])
  ) {
    return false
  }
  const source = element.getAttribute(SOURCE_ATTRIBUTE)
  if (
    !source ||
    source.length > HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT ||
    clipboardEncoder.encode(source).byteLength > HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT
  ) {
    return false
  }
  const parsed = parseHtmlSuperscriptLinkSource(source)
  const anchor = element.firstElementChild
  if (
    !parsed ||
    element.childNodes.length !== 1 ||
    element.children.length !== 1 ||
    !anchor ||
    element.firstChild !== anchor ||
    anchor.tagName !== 'A' ||
    !hasOnlyAttributes(anchor, ['href', 'title']) ||
    anchor.childNodes.length !== 1 ||
    anchor.firstChild?.nodeType !== window.Node.TEXT_NODE ||
    anchor.textContent !== parsed.label ||
    anchor.getAttribute('title') !== parsed.title ||
    anchor.getAttribute('href') !== projectMarkdownHrefForClipboard(parsed.href)
  ) {
    return false
  }
  return parsed
}

function hasOnlyAttributes(element: Element, allowed: string[]): boolean {
  const allowedSet = new Set(allowed)
  return Array.from(element.attributes).every((attribute) => allowedSet.has(attribute.name))
}

function isCitationShape(value: unknown): value is HtmlSuperscriptLinkSource {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    Object.keys(candidate).length === 4 &&
    typeof candidate.source === 'string' &&
    typeof candidate.href === 'string' &&
    typeof candidate.label === 'string' &&
    (typeof candidate.title === 'string' || candidate.title === null)
  )
}

function sameCitation(left: HtmlSuperscriptLinkSource, right: HtmlSuperscriptLinkSource): boolean {
  return (
    left.source === right.source &&
    left.href === right.href &&
    left.label === right.label &&
    left.title === right.title
  )
}
