import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Nodes } from 'mdast'

const markdownDefinitionProcessor = unified().use(remarkParse).use(remarkGfm)

// Unparsed documents keep the existing conservative Source fallback.
export function getMarkdownDefinitionUnsupportedReason(
  content: string
): 'reference-links' | 'footnotes' | null {
  try {
    const tree = markdownDefinitionProcessor.parse(content)
    if (containsDefinitionNode(tree, 'definition')) {
      return 'reference-links'
    }
    return containsDefinitionNode(tree, 'footnoteDefinition') ? 'footnotes' : null
  } catch {
    return 'reference-links'
  }
}

function containsDefinitionNode(node: Nodes, type: 'definition' | 'footnoteDefinition'): boolean {
  return (
    node.type === type ||
    ('children' in node && node.children.some((child) => containsDefinitionNode(child, type)))
  )
}
