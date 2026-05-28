import { decodeHtmlEntities, type AnyExtension, type Editor } from '@tiptap/core'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import type { PlaceholderOptions } from '@tiptap/extension-placeholder'
import { TextSelection } from '@tiptap/pm/state'
import {
  detailsBodyHtmlToMarkdown,
  escapeDetailsHtml,
  isEditableDetailsHtmlBlock,
  matchDetailsHtmlBlock,
  parseDetailsAttributes,
  renderDetailsAttributes,
  type DetailsHtmlToken
} from './details-markdown-html'

const RICH_MARKDOWN_PLACEHOLDER = 'Write markdown… Type / for blocks.'
const TOGGLE_TEXT_PLACEHOLDER = 'text'
const TOGGLE_HEADING_PLACEHOLDER = 'Heading 1'

export function getRichMarkdownPlaceholder({
  editor,
  node,
  pos
}: Parameters<
  Extract<PlaceholderOptions['placeholder'], (...args: never[]) => string>
>[0]): string {
  if (node.type.name !== 'detailsSummary') {
    return RICH_MARKDOWN_PLACEHOLDER
  }

  const parent = editor.state.doc.resolve(pos).parent
  return parent.type.name === 'details' && parent.attrs.variant === 'heading-1'
    ? TOGGLE_HEADING_PLACEHOLDER
    : TOGGLE_TEXT_PLACEHOLDER
}

export function moveDetailsSummarySelectionToContent(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  const { $from, empty } = selection

  if (!empty || $from.parent.type.name !== 'detailsSummary') {
    return false
  }

  const detailsDepth = $from.depth - 1
  if (detailsDepth < 1) {
    return false
  }

  const detailsNode = $from.node(detailsDepth)
  if (detailsNode.type.name !== 'details' || detailsNode.attrs.open === false) {
    return false
  }

  const detailsContent = detailsNode.child(1)
  if (detailsContent?.type.name !== 'detailsContent') {
    return false
  }

  const detailsStart = $from.before(detailsDepth)
  const detailsContentStart = detailsStart + 1 + detailsNode.child(0).nodeSize
  const firstBodyNode = detailsContent.firstChild
  if (!firstBodyNode?.isTextblock) {
    return false
  }

  const targetPos = detailsContentStart + 2
  const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(targetPos), 1))
  tr.scrollIntoView()
  view.dispatch(tr)

  return true
}

const OrcaDetails = Details.extend({
  // Why: details summary Enter must run before StarterKit's generic paragraph
  // splitting so typing a toggle title then pressing Enter moves into the body.
  priority: 1000,

  addAttributes() {
    return {
      ...this.parent?.(),
      variant: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-orca-toggle') === 'heading-1' ? 'heading-1' : null,
        renderHTML: ({ variant }) =>
          variant === 'heading-1' ? { 'data-orca-toggle': 'heading-1' } : {}
      }
    }
  },
  addKeyboardShortcuts() {
    const parentShortcuts = this.parent?.() ?? {}

    return {
      ...parentShortcuts,
      Enter: ({ editor }) =>
        moveDetailsSummarySelectionToContent(editor) || parentShortcuts.Enter?.({ editor }) || false
    }
  },
  markdownTokenizer: {
    name: 'details',
    level: 'block',
    start: '<details',
    tokenize(src, _tokens, lexer) {
      const detailsBlock = matchDetailsHtmlBlock(src, 0)
      if (!detailsBlock || !isEditableDetailsHtmlBlock(detailsBlock)) {
        return undefined
      }

      const summaryMatch = detailsBlock.inner.match(/^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i)
      if (!summaryMatch) {
        return undefined
      }

      const summary = decodeHtmlEntities(summaryMatch[1].trim())
      const body = detailsBlock.inner.slice((summaryMatch.index ?? 0) + summaryMatch[0].length)

      return {
        type: 'details',
        raw: detailsBlock.raw,
        block: true,
        attributes: parseDetailsAttributes(detailsBlock.openingAttributes),
        summaryTokens: lexer.inlineTokens(summary),
        bodyTokens: lexer.blockTokens(detailsBodyHtmlToMarkdown(body))
      } as DetailsHtmlToken
    }
  },
  parseMarkdown: (token, helpers) => {
    const detailsToken = token as DetailsHtmlToken
    if (detailsToken.type !== 'details') {
      return []
    }

    const summary = helpers.createNode(
      'detailsSummary',
      {},
      helpers.parseInline(detailsToken.summaryTokens ?? [])
    )
    const body = helpers.parseChildren(detailsToken.bodyTokens ?? [])
    const content = helpers.createNode(
      'detailsContent',
      {},
      body.length > 0 ? body : [helpers.createNode('paragraph')]
    )

    return helpers.createNode('details', detailsToken.attributes ?? {}, [summary, content])
  },
  renderMarkdown: (node, helpers) => {
    const summary = node.content?.find((child) => child.type === 'detailsSummary')
    const content = node.content?.find((child) => child.type === 'detailsContent')
    const summaryText = escapeDetailsHtml(
      decodeHtmlEntities(helpers.renderChildren(summary?.content ?? [], ''))
    )
    const body = helpers.renderChildren(content?.content ?? [], '\n\n').trim()
    const attrs = renderDetailsAttributes(node.attrs)

    return `<details ${attrs}>\n<summary>${summaryText}</summary>\n\n${body}\n\n</details>`
  }
})

const OrcaDetailsContent = DetailsContent.extend({
  // Why: detailsContent's double-Enter escape must run before StarterKit's
  // generic paragraph split, otherwise users can get stuck inside a toggle.
  priority: 1000
})

export function createOrcaDetailsExtensions(): AnyExtension[] {
  return [
    OrcaDetails.configure({
      persist: true,
      HTMLAttributes: {
        class: 'orca-details'
      }
    }),
    DetailsSummary,
    OrcaDetailsContent
  ]
}
