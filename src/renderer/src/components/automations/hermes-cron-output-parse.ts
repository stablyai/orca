export type ParsedHermesSection = {
  heading: string
  level: number
  body: string
}

export type ParsedHermesOutput = {
  title: string | null
  metadata: { label: string; value: string }[]
  sections: ParsedHermesSection[]
}

const METADATA_LINE_PATTERN = /^\*\*([^*]+):\*\*\s+(.+?)\s*$/
const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

type HermesLine = {
  line: string
  lineStart: number
  nextLineStart: number
}

export function parseHermesOutput(content: string): ParsedHermesOutput {
  let title: string | null = null
  const metadata: { label: string; value: string }[] = []
  let bodyStartOffset = 0

  forEachHermesLine(content, 0, ({ line, nextLineStart }) => {
    if (!title) {
      const titleMatch = /^#\s+(?:Cron Job:\s*)?(.+?)\s*$/.exec(line)
      if (titleMatch) {
        title = titleMatch[1]
        bodyStartOffset = nextLineStart
        return true
      }
    }
    const metaMatch = METADATA_LINE_PATTERN.exec(line)
    if (metaMatch) {
      metadata.push({ label: metaMatch[1].trim(), value: metaMatch[2].trim() })
      bodyStartOffset = nextLineStart
      return true
    }
    if (line.trim() === '') {
      if (metadata.length > 0 || title) {
        bodyStartOffset = nextLineStart
      }
      return true
    }
    return !(title || metadata.length > 0)
  })

  return {
    title,
    metadata,
    sections: splitHermesSections(content, bodyStartOffset)
  }
}

function splitHermesSections(content: string, startOffset: number): ParsedHermesSection[] {
  const sections: ParsedHermesSection[] = []
  let current: { heading: string; level: number; bodyStart: number; bodyEnd: number } | null = null

  forEachHermesLine(content, startOffset, ({ line, lineStart, nextLineStart }) => {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) {
        sections.push(createHermesSection(content, current))
      }
      current = {
        heading: heading[2],
        level: heading[1].length,
        bodyStart: nextLineStart,
        bodyEnd: nextLineStart
      }
      return true
    }
    if (current) {
      current.bodyEnd = nextLineStart
    } else {
      // Why: prose before the first structured heading was ignored by the
      // previous parser; preserving that keeps fallback rendering unchanged.
      void lineStart
    }
    return true
  })

  if (current) {
    sections.push(createHermesSection(content, current))
  }

  return sections
}

function createHermesSection(
  content: string,
  section: { heading: string; level: number; bodyStart: number; bodyEnd: number }
): ParsedHermesSection {
  return {
    heading: section.heading,
    level: section.level,
    body: normalizeHermesSectionBody(content, section.bodyStart, section.bodyEnd)
  }
}

const HERMES_TRIM_END_PATTERN = /\s/

function normalizeHermesSectionBody(content: string, start: number, end: number): string {
  let trimEnd = Math.min(end, content.length)
  while (trimEnd > start && HERMES_TRIM_END_PATTERN.test(content.charAt(trimEnd - 1))) {
    trimEnd -= 1
  }

  let normalized = ''
  let sliceStart = start

  // Why: automation output can be newline-heavy; normalize section CRLF pairs
  // while producing the section slice instead of running a full regex pass.
  for (let index = start; index < trimEnd; index += 1) {
    if (
      content.charCodeAt(index) !== CARRIAGE_RETURN_CODE_UNIT ||
      content.charCodeAt(index + 1) !== LINE_FEED_CODE_UNIT
    ) {
      continue
    }
    normalized += `${content.slice(sliceStart, index)}\n`
    index += 1
    sliceStart = index + 1
  }

  if (sliceStart === start) {
    return content.slice(start, trimEnd)
  }

  return normalized + content.slice(sliceStart, trimEnd)
}

function forEachHermesLine(
  content: string,
  startOffset: number,
  visitor: (line: HermesLine) => boolean
): void {
  let lineStart = startOffset

  for (let index = startOffset; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== LINE_FEED_CODE_UNIT) {
      continue
    }
    const lineEnd =
      index > lineStart && content.charCodeAt(index - 1) === CARRIAGE_RETURN_CODE_UNIT
        ? index - 1
        : index
    const shouldContinue = visitor({
      line: content.slice(lineStart, lineEnd),
      lineStart,
      nextLineStart: index + 1
    })
    if (!shouldContinue) {
      return
    }
    lineStart = index + 1
  }
}
