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

/**
 * One run of an item's own lines. An item holds several when nested lists divide
 * its content, and each run's position among the item's nested runs fixes where
 * its tokens land among the item's children.
 */
type ContentRun = {
  lines: string[]
  /** How many nested runs opened under this item before this one's lines. */
  after: number
}

/** An ordered item under construction, with the lines that belong to it. */
type CollectedItem = {
  indent: number
  column: number
  number: number
  /** The item's own lines, split into runs by the nested lists between them. */
  runs: ContentRun[]
  rawLines: string[]
  /** How many separate nested-list runs have opened under this item. */
  nestedRuns: number
  /** Whether the most recent line under this item opened or extended a nested run. */
  inNestedRun: boolean
  /** Index of the parent's nested run this item belongs to. */
  run: number
  /** The item this one nests under, absent at the list's own level. */
  parent: CollectedItem | undefined
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
        // Why: an item interrupted by its own content since the last nested item
        // starts a new nested run rather than extending the previous one.
        if (!frame.item.inNestedRun) {
          frame.item.nestedRuns += 1
          frame.item.inNestedRun = true
        }
      }
      const parent = stack.at(-1)
      const item: CollectedItem = {
        indent: itemIndent,
        column: itemIndent + number.length + 1 + gap.length,
        number: Number(number),
        runs: [{ lines: [content], after: 0 }],
        rawLines: [line],
        nestedRuns: 0,
        inNestedRun: false,
        run: parent === undefined ? 0 : parent.item.nestedRuns - 1,
        parent: parent?.item
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
    // Why: lazy continuation only extends a paragraph, so a line that opens a
    // block is placed by its own indent even with no blank line before it.
    const opensBlock = openFence === undefined && BLOCK_CONTENT_LINE.test(line.trimStart())
    // Why: without an intervening blank line the line lazily continues the
    // innermost open item's paragraph whatever its own indent, so only a line
    // after a blank one may be claimed by an outer item.
    let owner: OpenFrame | undefined = innermost
    if ((sawBlank || opensBlock) && openFence === undefined) {
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
  item.rawLines.push(raw)
  // Why: a blank line separates two items of one nested list, so it neither ends
  // the open nested run nor belongs to the item's own content around it.
  if (content.trim() === '' && item.inNestedRun) {
    return
  }
  const current = item.runs.at(-1)
  if (current !== undefined && current.after === item.nestedRuns) {
    current.lines.push(content)
  } else {
    item.runs.push({ lines: [content], after: item.nestedRuns })
  }
  item.inNestedRun = false
}

/**
 * Splits one run of an item's lines at the first blank or block-opening line.
 * `opensItem` marks the run that carries the item's marker line, whose first line
 * is the item's own text and so may not open a block.
 */
function splitItemContent(
  contentLines: string[],
  opensItem: boolean
): {
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
    if ((paragraphLines.length > 0 || !opensItem) && BLOCK_CONTENT_LINE.test(line.trimStart())) {
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

/**
 * The slice of an item's descendants that forms one of its nested-list runs: the
 * direct children carrying that run index, each followed by its own descendants.
 * A direct child is the one whose `parent` is this item, so a run's members are
 * fixed by the collector's block context rather than by how deep they sit: a run
 * that starts at its own indent stays separate from the one before it.
 */
function nestedRun(
  descendants: CollectedItem[],
  parent: CollectedItem,
  run: number
): CollectedItem[] {
  const result: CollectedItem[] = []
  let keeping = false
  for (const entry of descendants) {
    if (entry.parent === parent) {
      keeping = entry.run === run
    }
    if (keeping) {
      result.push(entry)
    }
  }
  return result
}

/**
 * Turns one run of collected items into `list_item` tokens. Every entry is either
 * emitted as an item of this list or gathered into one of its items' nested runs,
 * so no collected line is consumed without reaching the tree.
 */
function buildListItems(
  items: CollectedItem[],
  owner: CollectedItem | undefined,
  lexer: Lexer
): Tokens.ListItem[] {
  const result: Tokens.ListItem[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    let lookAhead = index + 1
    const nested: CollectedItem[] = []
    while (lookAhead < items.length && items[lookAhead].parent !== owner) {
      nested.push(items[lookAhead])
      lookAhead += 1
    }
    const tokens: Token[] = []
    let mainText = ''
    // Why: an item's own content and its nested lists interleave, so each run of
    // either is emitted at its own position to keep the children in source order.
    for (let run = 0; run <= item.nestedRuns; run += 1) {
      for (const content of item.runs.filter((entry) => entry.after === run)) {
        const { paragraphLines, blockLines } = splitItemContent(
          content.lines,
          content === item.runs[0]
        )
        const paragraphText = paragraphLines.join('\n').trim()
        if (paragraphText) {
          if (!mainText) {
            mainText = paragraphText
          }
          tokens.push({
            type: 'paragraph',
            raw: paragraphText,
            text: paragraphText,
            tokens: lexer.inlineTokens(paragraphText)
          } as Tokens.Paragraph)
        }
        const blockText = trimBlockText(blockLines)
        if (blockText) {
          tokens.push(...lexer.blockTokens(blockText))
        }
      }
      const runItems = nestedRun(nested, item, run)
      if (runItems.length > 0) {
        tokens.push({
          type: 'list',
          ordered: true,
          start: runItems[0].number,
          loose: false,
          items: buildListItems(runItems, item, lexer),
          raw: runItems.map((entry) => entry.rawLines.join('\n')).join('\n')
        } as Tokens.List)
      }
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
  const listItems = buildListItems(items, items[0].parent, lexer)
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
