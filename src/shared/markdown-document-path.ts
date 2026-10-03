export function isMarkdownDocumentPath(path: string): boolean {
  const lowerPath = path.toLowerCase()
  return lowerPath.endsWith('.md') || lowerPath.endsWith('.mdx') || lowerPath.endsWith('.markdown')
}
