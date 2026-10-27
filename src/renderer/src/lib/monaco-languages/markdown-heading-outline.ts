export type MarkdownHeadingSection = {
  level: number
  title: string
  /** 1-based line of the heading text; a setext heading starts on its text line. */
  startLine: number
  /** 1-based last line of the section's own heading line(s). */
  headingEndLine: number
  /** 1-based last line before the next heading of the same or a higher level. */
  endLine: number
  children: MarkdownHeadingSection[]
}

// Why: bounds the heading regexes' backtracking on pathological lines; real headings are far shorter.
const MAX_HEADING_LINE_LENGTH = 1000
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FRONT_MATTER_FENCE = /^(---|\+\+\+)[ \t]*$/
// Lines that cannot be a setext heading's text: they open their own block.
const NON_PARAGRAPH_START = /^ {0,3}(?:[-+*>|]|\d{1,9}[.)]|#{1,6}(?:[ \t]|$)|<)|^(?: {4}|\t)/

function isFenceClose(line: string, fence: string): boolean {
  const trimmed = line.trimStart()
  if (line.length - trimmed.length > 3 || !trimmed.startsWith(fence)) {
    return false
  }
  const run = trimmed.match(fence[0] === '`' ? /^`+/ : /^~+/)?.[0] ?? ''
  return run.length >= fence.length && trimmed.slice(run.length).trim() === ''
}

function frontMatterEnd(lines: readonly string[]): number {
  const open = lines[0]?.match(FRONT_MATTER_FENCE)?.[1]
  if (!open) {
    return 0
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trimEnd()
    if (line === open || (open === '---' && line === '...')) {
      return index + 1
    }
  }
  return 0
}

type FlatHeading = Omit<MarkdownHeadingSection, 'endLine' | 'children'>

// Why: a line scan keeps sticky scroll cheap on every edit; a full remark parse would block typing in large files.
function scanHeadings(lines: readonly string[]): FlatHeading[] {
  const headings: FlatHeading[] = []
  let fence: string | null = null
  let previousIsParagraph = false
  for (let index = frontMatterEnd(lines); index < lines.length; index += 1) {
    const line = lines[index]
    if (fence) {
      if (isFenceClose(line, fence)) {
        fence = null
      }
      previousIsParagraph = false
      continue
    }
    if (line.length > MAX_HEADING_LINE_LENGTH) {
      previousIsParagraph = true
      continue
    }
    const fenceOpen = line.match(FENCE_OPEN)?.[1]
    if (fenceOpen) {
      fence = fenceOpen
      previousIsParagraph = false
      continue
    }
    const atx = line.match(ATX_HEADING)
    if (atx) {
      headings.push({
        level: atx[1].length,
        title: (atx[2] ?? '').trim(),
        startLine: index + 1,
        headingEndLine: index + 1
      })
      previousIsParagraph = false
      continue
    }
    const underline = line.match(SETEXT_UNDERLINE)?.[1]
    if (underline && previousIsParagraph) {
      headings.push({
        level: underline[0] === '=' ? 1 : 2,
        title: lines[index - 1].trim(),
        startLine: index,
        headingEndLine: index + 1
      })
      previousIsParagraph = false
      continue
    }
    previousIsParagraph = line.trim() !== '' && !NON_PARAGRAPH_START.test(line)
  }
  return headings
}

/** Heading sections nested by level, each spanning until the next heading of the same or a higher level. */
export function buildMarkdownHeadingSections(lines: readonly string[]): MarkdownHeadingSection[] {
  const roots: MarkdownHeadingSection[] = []
  const open: MarkdownHeadingSection[] = []
  for (const heading of scanHeadings(lines)) {
    for (let last = open.at(-1); last && last.level >= heading.level; last = open.at(-1)) {
      last.endLine = heading.startLine - 1
      open.pop()
    }
    const section: MarkdownHeadingSection = { ...heading, endLine: lines.length, children: [] }
    ;(open.at(-1)?.children ?? roots).push(section)
    open.push(section)
  }
  return roots
}
