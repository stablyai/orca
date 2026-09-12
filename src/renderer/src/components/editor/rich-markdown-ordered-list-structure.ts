import type { Lexer, Token, Tokens } from 'marked'

// Why: `9. ` is three columns wide and `10. ` is four, so an item's content starts
// at a column its marker decides, not at a constant offset.
const ORDERED_ITEM = /^(\s*)(\d+)\.(\s+)(.*)$/
const INDENTED_LINE = /^\s/
const BLOCK_CONTENT_LINE = /^([-+*]\s+|\d+\.\s+|>\s?|```|~~~)/
// Why: a fence is at least three of its character, and the closing fence may not
// be shorter than the one that opened it (CommonMark section 4.5).
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/

type OpenFence = { marker: string; length: number; indent: number }

/**
 * Tracks whether the scan sits inside a fenced code block, so a line that looks
 * like a list marker is read as code. The opener's info string may not contain a
 * backtick, and only a fence of the same character and at least the same length
 * closes it.
 */
function nextFence(fence: OpenFence | undefined, line: string): OpenFence | undefined {
  const match = line.match(FENCE)
  if (!match) {
    return fence
  }
  const [, indent, marker, rest] = match
  if (fence === undefined) {
    if (marker.startsWith('`') && rest.includes('`')) {
      return undefined
    }
    return { marker: marker[0], length: marker.length, indent: indent.length }
  }
  const closes = marker[0] === fence.marker && marker.length >= fence.length && rest.trim() === ''
  return closes ? undefined : fence
}

/** An ordered item under construction, with the lines that belong to it. */
type CollectedItem = {
  indent: number
  column: number
  number: number
  /** Lines of the item's own content, before any nested list opens under it. */
  leadingLines: string[]
  /** Lines that follow a nested list inside the same item. */
  trailingLines: string[]
  rawLines: string[]
  /** Whether a nested item has opened under this one. */
  nested: boolean
}

type OpenFrame = { indent: number; column: number; item: CollectedItem }

/**
 * Groups an ordered list's lines by the item each line belongs to, tracking one
 * frame per open nesting level so a continuation reaches the item whose content
 * column it lines up under.
 */
function collectOrderedItems(lines: string[]): [CollectedItem[], number] {
  const items: CollectedItem[] = []
  const stack: OpenFrame[] = []
  let index = 0
  let sawBlank = false
  let fence: OpenFence | undefined
  while (index < lines.length) {
    const line = lines[index]
    const openFence = fence
    fence = nextFence(fence, line)
    const match = openFence === undefined ? line.match(ORDERED_ITEM) : null
    if (match) {
      const [, indent, number, gap, content] = match
      const itemIndent = indent.length
      while ((stack.at(-1)?.indent ?? -1) >= itemIndent) {
        stack.pop()
      }
      for (const frame of stack) {
        frame.item.nested = true
      }
      const item: CollectedItem = {
        indent: itemIndent,
        column: itemIndent + number.length + 1 + gap.length,
        number: Number(number),
        leadingLines: [content],
        trailingLines: [],
        rawLines: [line],
        nested: false
      }
      items.push(item)
      stack.push({ indent: item.indent, column: item.column, item })
      sawBlank = false
      index += 1
      continue
    }
    const innermost = stack.at(-1)
    if (innermost === undefined) {
      break
    }
    if (openFence === undefined && line.trim() === '') {
      appendToItem(innermost.item, '', line)
      sawBlank = true
      index += 1
      continue
    }
    if (openFence === undefined && !INDENTED_LINE.test(line)) {
      // Why: an unindented line after a blank one is outside the list entirely.
      if (sawBlank) {
        break
      }
      appendToItem(innermost.item, line, line)
      index += 1
      continue
    }
    const leading = line.match(/^[ \t]*/)?.[0].length ?? 0
    // Why: without an intervening blank line the line lazily continues the
    // innermost open item's paragraph whatever its own indent, so only a line
    // after a blank one may be claimed by an outer item.
    let owner: OpenFrame | undefined = innermost
    if (sawBlank && openFence === undefined) {
      // Why: a line indented less than every frame's content column belongs to no
      // item, which ends the list rather than joining its outermost one.
      owner = stack.findLast((frame) => leading >= frame.column)
      if (owner === undefined) {
        break
      }
    }
    appendToItem(owner.item, line.slice(Math.min(owner.column, leading)), line)
    while (stack.length > 0 && stack.at(-1) !== owner) {
      stack.pop()
    }
    sawBlank = false
    index += 1
  }
  return [items, index]
}

function appendToItem(item: CollectedItem, content: string, raw: string): void {
  if (item.nested) {
    item.trailingLines.push(content)
  } else {
    item.leadingLines.push(content)
  }
  item.rawLines.push(raw)
}

/** Splits an item's own lines at the first blank or block-opening line. */
function splitItemContent(contentLines: string[]): {
  paragraphLines: string[]
  blockLines: string[]
} {
  const paragraphLines: string[] = []
  const blockLines: string[] = []
  let reachedBlock = false
  for (const line of contentLines) {
    if (reachedBlock) {
      blockLines.push(line)
      continue
    }
    if (line.trim() === '') {
      reachedBlock = true
      blockLines.push(line)
      continue
    }
    if (paragraphLines.length > 0 && BLOCK_CONTENT_LINE.test(line.trimStart())) {
      reachedBlock = true
      blockLines.push(line)
      continue
    }
    paragraphLines.push(line)
  }
  return { paragraphLines, blockLines }
}

/**
 * Drops the blank lines that separate a block from what precedes it, and any
 * trailing whitespace, keeping the leading indentation of the first content line.
 * Four columns of it makes an indented code block, so trimming the block whole
 * turns that code into a paragraph.
 */
function trimBlockText(lines: string[]): string {
  let start = 0
  while (start < lines.length && lines[start].trim() === '') {
    start += 1
  }
  let end = lines.length
  while (end > start && lines[end - 1].trim() === '') {
    end -= 1
  }
  return lines
    .slice(start, end)
    .map((line) => line.trimEnd())
    .join('\n')
}

/** Turns the collected items at one nesting level into `list_item` tokens. */
function buildListItems(
  items: CollectedItem[],
  baseIndent: number,
  lexer: Lexer
): Tokens.ListItem[] {
  const result: Tokens.ListItem[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item.indent !== baseIndent) {
      index += 1
      continue
    }
    const { paragraphLines, blockLines } = splitItemContent(item.leadingLines)
    const tokens: Token[] = []
    const mainText = paragraphLines.join('\n').trim()
    if (mainText) {
      tokens.push({
        type: 'paragraph',
        raw: mainText,
        text: mainText,
        tokens: lexer.inlineTokens(mainText)
      } as Tokens.Paragraph)
    }
    const blockText = trimBlockText(blockLines)
    if (blockText) {
      tokens.push(...lexer.blockTokens(blockText))
    }
    let lookAhead = index + 1
    const nested: CollectedItem[] = []
    while (lookAhead < items.length && items[lookAhead].indent > baseIndent) {
      nested.push(items[lookAhead])
      lookAhead += 1
    }
    if (nested.length > 0) {
      const nextIndent = Math.min(...nested.map((entry) => entry.indent))
      tokens.push({
        type: 'list',
        ordered: true,
        start: nested[0].number,
        loose: false,
        items: buildListItems(nested, nextIndent, lexer),
        raw: nested.map((entry) => entry.rawLines.join('\n')).join('\n')
      } as Tokens.List)
    }
    // Why: content after a nested list belongs to the same item but must follow
    // the nested list token so the item's children keep their source order.
    const trailingText = trimBlockText(item.trailingLines)
    if (trailingText) {
      tokens.push(...lexer.blockTokens(trailingText))
    }
    result.push({
      type: 'list_item',
      raw: item.rawLines.join('\n'),
      text: mainText,
      task: false,
      checked: undefined,
      loose: false,
      tokens
    } as Tokens.ListItem)
    index = lookAhead
  }
  return result
}

/** Tokenizes an ordered list, keeping each continuation line inside its own item. */
export function tokenizeOrderedList(source: string, lexer: Lexer): Tokens.List | undefined {
  const lines = source.split('\n')
  const [items, consumed] = collectOrderedItems(lines)
  if (items.length === 0) {
    return undefined
  }
  const listItems = buildListItems(items, items[0].indent, lexer)
  if (listItems.length === 0) {
    return undefined
  }
  return {
    type: 'list',
    ordered: true,
    start: items[0].number,
    loose: false,
    items: listItems,
    raw: lines.slice(0, consumed).join('\n')
  } as Tokens.List
}
