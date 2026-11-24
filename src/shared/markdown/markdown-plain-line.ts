/** One line of Markdown as plain words: no `**`, `#`, list marks, code ticks or link syntax. Code
 *  spans keep their contents as written. */
export function markdownPlainLine(line: string): string {
  return line
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])(?:\s+|$)/, '')
    .split(/(`[^`]*`)/)
    .map((part, index) => (index % 2 === 1 ? part.slice(1, -1) : withoutMarks(part)))
    .join('')
    .trim()
}

function withoutMarks(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
}
