import {
  createMarkdownFenceRangeCursor,
  createMarkdownFenceTracker,
  getMarkdownFenceRanges
} from './markdown-fence-scanner'

type ReferenceLinkDefinition = {
  label: string
  title: string | null
  url: string
}

const REFERENCE_DEFINITION_PATTERN =
  /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]+>|[^\s]+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/

function normalizeReferenceLabel(label: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < label.length; index += 1) {
    const code = label.charCodeAt(index)
    if (isMarkdownReferenceLabelWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += label.charAt(index)
  }
  return normalized.toLowerCase()
}

// Why: pasted markdown labels can be large; matching only needs collapsed
// reference-label whitespace, not a full-string whitespace regex pass.
function isMarkdownReferenceLabelWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

function unwrapReferenceUrl(rawUrl: string): string {
  return rawUrl.startsWith('<') && rawUrl.endsWith('>') ? rawUrl.slice(1, -1) : rawUrl
}

function parseReferenceDefinition(line: string): ReferenceLinkDefinition | null {
  const match = line.match(REFERENCE_DEFINITION_PATTERN)
  if (!match) {
    return null
  }

  return {
    label: normalizeReferenceLabel(match[1]),
    url: unwrapReferenceUrl(match[2]),
    title: match[3] ?? match[4] ?? match[5] ?? null
  }
}

function splitReferenceDefinitions(content: string): {
  definitions: Map<string, ReferenceLinkDefinition>
  markdown: string
} {
  const definitions = new Map<string, ReferenceLinkDefinition>()
  const fence = createMarkdownFenceTracker()
  let markdown = ''

  forEachReferenceDefinitionLine(content, (line, newline) => {
    const isFenceLine = fence.consume(line)
    const definition = isFenceLine || fence.insideFence ? null : parseReferenceDefinition(line)
    if (definition) {
      definitions.set(definition.label, definition)
      return
    }

    markdown += line + newline
  })

  return { definitions, markdown }
}

function forEachReferenceDefinitionLine(
  content: string,
  visit: (line: string, newline: string) => void
): void {
  let lineStart = 0
  for (let index = 0; index <= content.length; index += 1) {
    const codeUnit = index < content.length ? content.charCodeAt(index) : 10
    if (index < content.length && codeUnit !== 10 && codeUnit !== 13) {
      continue
    }
    const hasLineEnding = index < content.length
    const hasCrLf = codeUnit === 13 && content.charCodeAt(index + 1) === 10
    const newline = hasLineEnding ? (hasCrLf ? '\r\n' : content[index]) : ''
    visit(content.slice(lineStart, index), newline)
    if (hasCrLf) {
      index += 1
    }
    lineStart = index + 1
  }
}

function isEscaped(content: string, index: number): boolean {
  let backslashCount = 0
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function findClosingBracket(content: string, start: number): number {
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === ']' && !isEscaped(content, index)) {
      return index
    }
  }
  return -1
}

function formatInlineReferenceLink(text: string, definition: ReferenceLinkDefinition): string {
  const escapedUrl = definition.url.replace(/[()\\]/g, '\\$&')
  if (!definition.title) {
    return `[${text}](${escapedUrl})`
  }
  const escapedTitle = definition.title.replace(/["\\]/g, '\\$&')
  return `[${text}](${escapedUrl} "${escapedTitle}")`
}

function replaceReferenceLinks(
  markdown: string,
  definitions: Map<string, ReferenceLinkDefinition>
): string {
  let result = ''
  let index = 0
  const isInsideFence = createMarkdownFenceRangeCursor(getMarkdownFenceRanges(markdown))

  while (index < markdown.length) {
    if (isInsideFence(index) || markdown[index] !== '[' || isEscaped(markdown, index)) {
      result += markdown[index]
      index += 1
      continue
    }

    const closingTextIndex = findClosingBracket(markdown, index + 1)
    if (closingTextIndex === -1) {
      result += markdown[index]
      index += 1
      continue
    }

    const text = markdown.slice(index + 1, closingTextIndex)
    const afterText = markdown[closingTextIndex + 1]
    if (afterText === '(') {
      result += markdown[index]
      index += 1
      continue
    }

    if (afterText === '[') {
      const closingLabelIndex = findClosingBracket(markdown, closingTextIndex + 2)
      if (closingLabelIndex !== -1) {
        const rawLabel = markdown.slice(closingTextIndex + 2, closingLabelIndex)
        const label = normalizeReferenceLabel(rawLabel || text)
        const definition = definitions.get(label)
        if (definition) {
          result += formatInlineReferenceLink(text, definition)
          index = closingLabelIndex + 1
          continue
        }
      }
    } else {
      const definition = definitions.get(normalizeReferenceLabel(text))
      if (definition) {
        result += formatInlineReferenceLink(text, definition)
        index = closingTextIndex + 1
        continue
      }
    }

    result += markdown[index]
    index += 1
  }

  return result
}

export function normalizeMarkdownReferenceLinks(content: string): string {
  const { definitions, markdown } = splitReferenceDefinitions(content)
  if (definitions.size === 0) {
    return content
  }

  // Why: Tiptap's Markdown parser drops reference definitions but leaves
  // shortcut references as plain text. Inline them before parsing so Linear
  // issue mentions keep their links in the rich description editor.
  return replaceReferenceLinks(markdown, definitions)
}
