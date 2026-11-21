/**
 * Replace comments with spaces so declaration scanners never read commented-out code. Offsets and
 * line breaks are unchanged, and string contents are left alone because module specifiers live there.
 */
export function blankComments(source: string): string {
  let result = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '"' || char === "'" || char === '`') {
      const start = index++
      while (index < source.length && source[index] !== char) {
        // A normal string cannot span lines; stop there so one stray quote does not swallow the file.
        if (source[index] === '\n' && char !== '`') {
          break
        }
        index += source[index] === '\\' ? 2 : 1
      }
      index = Math.min(index + 1, source.length)
      result += source.slice(start, index)
    } else if (char === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? source.indexOf('\n', index) : source.indexOf('*/', index + 2)
      const stop = close === -1 ? source.length : next === '/' ? close : close + 2
      result += source.slice(index, stop).replace(/[^\n]/g, ' ')
      index = stop
    } else {
      result += char
      index++
    }
  }
  return result
}
