// Every provider renders `<tabs><index> <role> ...` element lines between a header and a footer.
export type ComputerTreeElement = {
  index: number
  depth: number
  // The element line plus any unindexed lines that follow it, such as omitted-tab notes.
  lines: string[]
}

export type ComputerTreeText = {
  header: string[]
  elements: ComputerTreeElement[]
  footer: string[]
}

const ELEMENT_LINE = /^(\t*)(\d+)(?= |$)/u

export function parseComputerTreeText(treeText: string): ComputerTreeText {
  const lines = treeText.split('\n')
  const first = lines.findIndex((line) => ELEMENT_LINE.test(line))
  if (first === -1) {
    return { header: lines, elements: [], footer: [] }
  }
  const lastElement = lines.findLastIndex((line) => ELEMENT_LINE.test(line))
  // Why: the footer starts at the first blank line after the last element; anything else between
  // elements belongs to the element above, including names that carried raw newlines.
  const blank = lines.indexOf('', lastElement)
  const footerStart = blank === -1 ? lines.length : blank
  const elements: ComputerTreeElement[] = []
  for (const line of lines.slice(first, footerStart)) {
    const match = ELEMENT_LINE.exec(line)
    if (match) {
      elements.push({ index: Number(match[2]), depth: match[1].length, lines: [line] })
    } else {
      elements.at(-1)?.lines.push(line)
    }
  }
  return { header: lines.slice(0, first), elements, footer: lines.slice(footerStart) }
}

export function joinComputerTreeText(header: string[], body: string[], footer: string[]): string {
  return [...trimTrailingBlank(header), '', ...body, ...footer].join('\n')
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') {
    end -= 1
  }
  return lines.slice(0, end)
}
