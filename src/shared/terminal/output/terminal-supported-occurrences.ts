import type { TerminalSupportQuery } from './terminal-content-origin'

export function lastSupportedIndex(
  text: string,
  term: string,
  support?: TerminalSupportQuery,
  before = text.length
): number {
  for (
    let index = text.lastIndexOf(term, before);
    index >= 0;
    index = text.lastIndexOf(term, index - 1)
  ) {
    if (!support || support(index, index + term.length)) {
      return index
    }
    if (index === 0) {
      break
    }
  }
  return -1
}

export function supportedRegexMatches(
  text: string,
  pattern: RegExp,
  support?: TerminalSupportQuery
): RegExpMatchArray[] {
  return [
    ...text.matchAll(
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    )
  ].filter((match) => !support || support(match.index!, match.index! + match[0].length))
}
