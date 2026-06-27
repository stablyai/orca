import { decodeHtmlEntities, type AnyExtension, type Editor } from '@tiptap/core'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import type { PlaceholderOptions } from '@tiptap/extension-placeholder'
import { TextSelection } from '@tiptap/pm/state'
import {
  detailsBodyHtmlToMarkdown,
  escapeDetailsHtml,
  extractDetailsSummaryHtml,
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

export function moveFromEmptyDetailsBodyToSummary(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  const { $from, empty } = selection

  if (!empty || !$from.parent.isTextblock || $from.parent.content.size !== 0) {
    return false
  }

  if ($from.parentOffset !== 0) {
    return false
  }

  const detailsContentDepth = $from.depth - 1
  if (detailsContentDepth < 1) {
    return false
  }

  const detailsContentNode = $from.node(detailsContentDepth)
  if (
    detailsContentNode.type.name !== 'detailsContent' ||
    detailsContentNode.childCount !== 1 ||
    $from.index(detailsContentDepth) !== 0
  ) {
    return false
  }

  const detailsDepth = detailsContentDepth - 1
  const detailsNode = $from.node(detailsDepth)
  if (detailsNode.type.name !== 'details' || detailsNode.childCount < 2) {
    return false
  }

  const summaryNode = detailsNode.child(0)
  if (summaryNode.type.name !== 'detailsSummary') {
    return false
  }

  const detailsStart = $from.before(detailsDepth)
  const summaryStart = detailsStart + 1
  const summaryTextEnd = summaryStart + summaryNode.nodeSize - 1

  // Why: Backspace from an empty toggle body should first make the summary
  // cursor visible; deletion is reserved for the next Backspace.
  const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(summaryTextEnd), -1))
  tr.scrollIntoView()
  view.dispatch(tr)

  return true
}

export function exitEmptyDetailsBody(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  const { $from, empty } = selection

  if (!empty || !$from.parent.isTextblock || $from.parent.content.size !== 0) {
    return false
  }

  const detailsContentDepth = $from.depth - 1
  if (detailsContentDepth < 1) {
    return false
  }

  const detailsContentNode = $from.node(detailsContentDepth)
  if (detailsContentNode.type.name !== 'detailsContent') {
    return false
  }

  const childIndex = $from.index(detailsContentDepth)
  if (childIndex !== detailsContentNode.childCount - 1) {
    return false
  }

  const detailsDepth = detailsContentDepth - 1
  const detailsNode = $from.node(detailsDepth)
  if (detailsNode.type.name !== 'details') {
    return false
  }

  const paragraphType = state.schema.nodes.paragraph
  const paragraph = paragraphType?.createAndFill()
  if (!paragraph) {
    return false
  }

  const currentBlockFrom = $from.before($from.depth)
  const currentBlockTo = $from.after($from.depth)
  const shouldRemoveTrailingEmptyBlock = detailsContentNode.childCount > 1
  let insertPos = $from.after(detailsDepth)
  const tr = state.tr

  if (shouldRemoveTrailingEmptyBlock) {
    tr.delete(currentBlockFrom, currentBlockTo)
    insertPos -= currentBlockTo - currentBlockFrom
  }

  // Why: an empty toggle body must have an Enter escape hatch, while the
  // detailsContent node still needs one child to stay schema-valid.
  tr.insert(insertPos, paragraph)
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
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

      const summaryHtml = extractDetailsSummaryHtml(detailsBlock.inner)
      if (!summaryHtml) {
        return undefined
      }

      const summary = decodeHtmlEntities(summaryHtml.content.trim())
      const body = detailsBlock.inner.slice(summaryHtml.rawLength)

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
  priority: 1000,

  addKeyboardShortcuts() {
    const parentShortcuts = this.parent?.() ?? {}

    return {
      ...parentShortcuts,
      Enter: ({ editor }) =>
        exitEmptyDetailsBody(editor) || parentShortcuts.Enter?.({ editor }) || false,
      Backspace: ({ editor }) =>
        moveFromEmptyDetailsBodyToSummary(editor) ||
        parentShortcuts.Backspace?.({ editor }) ||
        false
    }
  }
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
