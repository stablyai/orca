// Shows raw HTML in markdown as the text that was typed, instead of parsing it as markup.

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
}

/** Containers whose children are blocks, so a block of HTML has to become a paragraph there. */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

function literalizeHtml(node: MarkdownNode): void {
  if (!node.children) {
    return
  }
  const blockParent = BLOCK_PARENTS.has(node.type)
  node.children = node.children.map((child) => {
    if (child.type !== 'html') {
      literalizeHtml(child)
      return child
    }
    const text = { type: 'text', value: child.value ?? '' }
    return blockParent ? { type: 'paragraph', children: [text] } : text
  })
}

/** Why: a person's prompt is what they typed; `<se-tabs>` there is words, not markup to sanitize away. */
export function remarkLiteralHtml(): (tree: MarkdownNode) => void {
  return (tree) => literalizeHtml(tree)
}
