export const DOC_LINK_PATTERN = /\[\[([^[\]\r\n]+)\]\]/g
const DOC_LINK_OPEN = '[['

type DocLinkTextNodeContext = {
  type: { name: string }
  text?: string
  marks: readonly { type: { name: string } }[]
}

type DocLinkParentContext = {
  type: { spec: { code?: boolean } }
}

export function isDocLinkLiteralCodeTextNode(
  node: Pick<DocLinkTextNodeContext, 'marks'>,
  parent: DocLinkParentContext | null
): boolean {
  return parent?.type.spec.code === true || node.marks.some((mark) => mark.type.name === 'code')
}

// A link match requires the exact ASCII opener, including for non-ASCII targets.
export function canHoldDocLink(
  node: DocLinkTextNodeContext,
  parent: DocLinkParentContext | null
): node is DocLinkTextNodeContext & { text: string } {
  return (
    node.type.name === 'text' &&
    !!node.text &&
    node.text.includes(DOC_LINK_OPEN) &&
    !isDocLinkLiteralCodeTextNode(node, parent)
  )
}
