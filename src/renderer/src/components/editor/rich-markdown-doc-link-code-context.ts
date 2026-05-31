type DocLinkTextNodeContext = {
  marks: readonly { type: { name: string } }[]
}

type DocLinkParentContext = {
  type: { spec: { code?: boolean } }
}

// Why: inline/fenced code content is literal markdown; auto-converting it would
// corrupt examples and commands that intentionally contain [[...]] text.
export function isDocLinkLiteralCodeTextNode(
  node: DocLinkTextNodeContext,
  parent: DocLinkParentContext | null
): boolean {
  return parent?.type.spec.code === true || node.marks.some((mark) => mark.type.name === 'code')
}
