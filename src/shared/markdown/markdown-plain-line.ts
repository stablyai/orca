// Code spans stand aside as numbered placeholders, so marks around them still pair. Built at runtime:
// a literal control or private-use character in source is rewritten raw by the formatter and bundler.
const OPEN = String.fromCharCode(1)
const CLOSE = String.fromCharCode(2)
const PLACEHOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g')
const DELIMITERS = new RegExp(`[${OPEN}${CLOSE}]`, 'g')

/** One line of Markdown as plain words: no `**`, `#`, list marks, code ticks or link syntax. Code
 *  spans keep their contents as written. */
export function markdownPlainLine(line: string): string {
  const spans: string[] = []
  // The delimiters are dropped from the input first, so only real code spans become placeholders.
  return line
    .replace(DELIMITERS, '')
    .replace(/`([^`]*)`/g, (_, code: string) => `${OPEN}${spans.push(code) - 1}${CLOSE}`)
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])(?:\s+|$)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(PLACEHOLDER, (_, index: string) => spans[Number(index)] ?? '')
    .trim()
}
