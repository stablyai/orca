/** One line of Markdown as plain words: no `**`, `#`, list marks, code ticks or link syntax. Code
 *  spans keep their contents as written. */
export function markdownPlainLine(line: string): string {
  const spans: string[] = []
  // Code spans stand aside as private-use placeholders, so marks around them still pair.
  const masked = line.replace(/`([^`]*)`/g, (_, code: string) => `${spans.push(code) - 1}`)
  return masked
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])(?:\s+|$)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/(\d+)/g, (_, index: string) => spans[Number(index)] ?? '')
    .trim()
}
