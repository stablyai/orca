export function attachmentTextSegments(text: string): string[] {
  const segments: string[] = []
  let line = ''
  let columns = 0
  for (const character of text) {
    line += character
    columns++
    if (character === '\n' || columns === 256) {
      segments.push(line)
      line = ''
      columns = 0
    }
  }
  if (line || !segments.length) {
    segments.push(line)
  }
  return segments
}
