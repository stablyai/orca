/** End of a start tag: the first `>` outside a quoted value, or -1. Only a quote right after `=` opens one. */
export function htmlStartTagEnd(html: string, from: number): number {
  let state: 'name' | 'equals' | 'unquoted' = 'name'
  for (let index = from; index < html.length; index += 1) {
    const char = html[index]!
    if (char === '>') {
      return index
    }
    const space = char === ' ' || (char >= '\t' && char <= '\r')
    if (state === 'equals') {
      if (char === '"' || char === "'") {
        index = html.indexOf(char, index + 1)
        if (index === -1) {
          return -1
        }
        state = 'name'
      } else if (!space) {
        state = 'unquoted'
      }
    } else if (space) {
      state = 'name'
    } else if (state === 'name' && char === '=') {
      state = 'equals'
    }
  }
  return -1
}
