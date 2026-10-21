import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

type Range = [number, number]
type Replacement = { start: number; end: number; value: string }

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, {
  singleDollarTextMath: false
})
const protectedTypes = new Set(['code', 'inlineCode', 'html', 'link', 'image', 'definition'])
const containerTypes = new Set(['listItem', 'blockquote', 'table'])
const latexDelimiters = /\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)/g

function overlaps(ranges: Range[], start: number, end: number): boolean {
  return ranges.some(([a, b]) => a < end && b > start)
}

function escaped(source: string, offset: number): boolean {
  let slashes = 0
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index--) {
    slashes++
  }
  return slashes % 2 === 1
}

function collectRanges(node: Nodes, protectedRanges: Range[], displayRanges: Range[]): void {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start !== undefined && end !== undefined) {
    if (protectedTypes.has(node.type) || node.type === 'math') {
      protectedRanges.push([start, end])
      displayRanges.push([start, end])
      return
    }
    if (node.type === 'inlineMath') {
      protectedRanges.push([start, end])
    }
    if (containerTypes.has(node.type)) {
      displayRanges.push([start, end])
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      collectRanges(child, protectedRanges, displayRanges)
    }
  }
}

function standaloneDisplay(source: string, ranges: Range[]): Replacement[] {
  const replacements: Replacement[] = []
  let offset = 0
  for (const line of source.split(/(?<=\n)/)) {
    const raw = line.replace(/[\r\n]+$/, '')
    const match = /^ {0,3}\$\$([^\r\n]+)\$\$[ \t]*$/.exec(raw)
    if (
      match &&
      match[1].trim() &&
      !match[1].startsWith('$') &&
      !match[1].endsWith('$') &&
      !match[1].includes('$$') &&
      !escaped(raw, raw.lastIndexOf('$$')) &&
      !overlaps(ranges, offset, offset + raw.length)
    ) {
      replacements.push({
        start: offset,
        end: offset + raw.length,
        value: `\n$$\n${match[1].trim()}\n$$\n`
      })
    }
    offset += line.length
  }
  return replacements
}

function dollarRun(source: string, start: number): number {
  let end = start
  while (source[end] === '$') {
    end++
  }
  return end - start
}

function singleDollarMath(source: string, ranges: Range[]): Replacement[] {
  const replacements: Replacement[] = []
  for (let open = 0; open < source.length; open++) {
    if (source[open] !== '$' || escaped(source, open) || overlaps(ranges, open, open + 1)) {
      continue
    }
    const run = dollarRun(source, open)
    if (run >= 2) {
      // An unfinished multi-dollar region must not become a single-dollar expression.
      let close = open + run
      for (; close < source.length; close++) {
        if (source[close] === '$' && !escaped(source, close)) {
          const closingRun = dollarRun(source, close)
          if (closingRun === run) {
            break
          }
          close += closingRun - 1
        }
      }
      open = close < source.length ? close + run - 1 : source.length
      continue
    }
    if (!source[open + 1] || /\s/.test(source[open + 1])) {
      continue
    }
    let close = open + 1
    for (; close < source.length && !/[\r\n]/.test(source[close]); close++) {
      if (source[close] === '$' && !escaped(source, close)) {
        break
      }
    }
    if (close >= source.length || /[\r\n]/.test(source[close])) {
      continue
    }
    const body = source.slice(open + 1, close)
    if (
      !body ||
      /\s/.test(body.at(-1) ?? '') ||
      /\d/.test(source[close + 1] ?? '') ||
      dollarRun(source, close) !== 1 ||
      overlaps(ranges, open, close + 1)
    ) {
      continue
    }
    // Keep adjacent prices such as $10和$20; explicit operators still allow $10 - 1$.
    if (
      /^[+-]?\d[\d,]*(?:\.\d+)?(?:[^\p{ASCII}]|\s)/u.test(body) &&
      !/[\\_^=<>+*/{}-]/.test(body)
    ) {
      continue
    }
    replacements.push({ start: open, end: close + 1, value: `$$${body}$$` })
    open = close
  }
  return replacements
}

/** Normalize raw delimiters once, so converted inline expressions cannot become display math. */
export function normalizeChatMathDelimiters(source: string): string {
  if (!source.includes('$') && !source.includes('\\[') && !source.includes('\\(')) {
    return source
  }
  const protectedRanges: Range[] = []
  const displayRanges: Range[] = []
  collectRanges(parser.parse(source), protectedRanges, displayRanges)
  const replacements = standaloneDisplay(source, displayRanges)
  const inlineRanges = [
    ...protectedRanges,
    ...replacements.map(({ start, end }): Range => [start, end])
  ]
  for (const match of source.matchAll(latexDelimiters)) {
    const start = match.index
    const end = start + match[0].length
    if (escaped(source, start) || escaped(source, end - 2) || overlaps(inlineRanges, start, end)) {
      continue
    }
    const block = match[1]
    const inline = match[2]
    if (!(block ?? inline).trim()) {
      continue
    }
    replacements.push({
      start,
      end,
      value: block !== undefined ? `\n$$\n${block.trim()}\n$$\n` : `$$${inline}$$`
    })
    inlineRanges.push([start, end])
  }
  replacements.push(...singleDollarMath(source, inlineRanges))
  let result = ''
  let cursor = 0
  for (const { start, end, value } of replacements.sort((a, b) => a.start - b.start)) {
    result += source.slice(cursor, start) + value
    cursor = end
  }
  return result + source.slice(cursor)
}
