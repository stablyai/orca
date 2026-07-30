type MarkdownAstNode = {
  type: string
  value?: string
  data?: {
    hChildren?: MarkdownAstNode[]
  }
  children?: MarkdownAstNode[]
}

function normalizeGitHubBacktickMathNode(node: MarkdownAstNode): void {
  if (
    node.type === 'inlineMath' &&
    node.value?.startsWith('`') &&
    node.value.endsWith('`') &&
    node.value.length >= 2
  ) {
    const value = node.value.slice(1, -1)
    node.value = value

    const renderedText = node.data?.hChildren?.[0]
    if (renderedText?.type === 'text') {
      renderedText.value = value
    }
  }

  for (const child of node.children ?? []) {
    normalizeGitHubBacktickMathNode(child)
  }
}

export function remarkGitHubBacktickMath(): (tree: MarkdownAstNode) => void {
  return normalizeGitHubBacktickMathNode
}
