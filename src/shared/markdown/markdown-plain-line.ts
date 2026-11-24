/** One line of Markdown as plain words: no `**`, `#`, list marks, code ticks or link syntax. */
export function markdownPlainLine(line: string): string {
  return line
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])(?:\s+|$)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}
