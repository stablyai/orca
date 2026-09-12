/** Replaces complete HTML comments, leaving an unterminated suffix intact. */
export function replaceHtmlComments(content: string, replacement: '' | ' ' = ''): string {
  const lastClose = content.lastIndexOf('-->')
  if (lastClose === -1) {
    return content
  }
  // Exclude the suffix where each unmatched opener would rescan for a nonexistent closer.
  const end = lastClose + 3
  return content.slice(0, end).replace(/<!--[\s\S]*?-->/g, replacement) + content.slice(end)
}
