import type {
  BrowserGrabComputedStyles,
  BrowserGrabPayload,
  BrowserPageAnnotation
} from '../../../../shared/browser-grab-types'

function formatPageHeading(payload: BrowserGrabPayload): string {
  try {
    const url = new URL(payload.page.sanitizedUrl)
    return `${url.pathname}${url.search}`
  } catch {
    return payload.page.sanitizedUrl || 'current page'
  }
}

function annotationElementLabel(payload: BrowserGrabPayload): string {
  const react = payload.target.reactComponents
  const accessibleName = payload.target.accessibility.accessibleName
  const base = accessibleName
    ? `${payload.target.tagName} "${inlineText(accessibleName)}"`
    : payload.target.textSnippet
      ? `${payload.target.tagName} "${inlineText(payload.target.textSnippet).slice(0, 60)}"`
      : payload.target.tagName
  return react ? `${inlineText(react)} ${base}` : base
}

export const BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH = 2048

function inlineText(
  content: string,
  maxLength = BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH
): string {
  // Why: page-controlled DOM text can include paste-sized content. Inline
  // annotation fields are prompt previews, so collapse whitespace while
  // scanning only the bounded text we will actually retain.
  let normalized = ''
  let pendingSpace = false
  for (let index = 0; index < content.length && normalized.length < maxLength; ) {
    const code = content.charCodeAt(index)
    if (isInlineWhitespaceCode(code)) {
      if (code === 13 && content.charCodeAt(index + 1) === 10) {
        index += 1
      }
      pendingSpace = normalized.length > 0
      index += 1
      continue
    }

    const codePoint = content.codePointAt(index)
    if (codePoint === undefined) {
      break
    }
    const char = String.fromCodePoint(codePoint)
    const extraSpaceLength = pendingSpace ? 1 : 0
    if (normalized.length + extraSpaceLength + char.length > maxLength) {
      break
    }
    if (pendingSpace) {
      normalized += ' '
      pendingSpace = false
    }
    normalized += char
    index += char.length
  }
  return normalized
}

function isInlineWhitespaceCode(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

function formatStyles(styles: BrowserGrabComputedStyles): string[] {
  const lines: string[] = []
  const entries: [string, string][] = [
    ['display', styles.display],
    ['position', styles.position],
    ['width', styles.width],
    ['height', styles.height],
    ['margin', styles.margin],
    ['padding', styles.padding],
    ['color', styles.color],
    ['background', styles.backgroundColor],
    ['border', styles.border],
    ['border-radius', styles.borderRadius],
    ['font-family', styles.fontFamily],
    ['font-size', styles.fontSize],
    ['font-weight', styles.fontWeight],
    ['line-height', styles.lineHeight],
    ['text-align', styles.textAlign],
    ['z-index', styles.zIndex]
  ]
  for (const [name, value] of entries) {
    if (!value || value === 'auto' || value === 'normal') {
      continue
    }
    if (name === 'position' && value === 'static') {
      continue
    }
    if (name === 'display' && value === 'inline') {
      continue
    }
    if (name === 'background' && value === 'rgba(0, 0, 0, 0)') {
      continue
    }
    lines.push(`- ${name}: ${value}`)
  }
  return lines
}

// Why: annotation snippets come from page DOM; avoid spreading every backtick
// run into Math.max when generated HTML contains many fence characters.
function maxBacktickRunLength(content: string, floor: number): number {
  let maxRun = floor
  let currentRun = 0

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 96) {
      currentRun = 0
      continue
    }

    currentRun += 1
    if (currentRun > maxRun) {
      maxRun = currentRun
    }
  }
  return maxRun
}

function fence(language: string, content: string): string[] {
  const maxRun = maxBacktickRunLength(content, 3)
  const marker = '`'.repeat(maxRun + 1)
  return [`${marker}${language}`, content, marker]
}

function inlineCode(content: string): string {
  const maxRun = maxBacktickRunLength(content, 0)
  const marker = '`'.repeat(maxRun + 1)
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${marker}${padding}${content}${padding}${marker}`
}

export function formatBrowserAnnotationsAsMarkdown(annotations: BrowserPageAnnotation[]): string {
  if (annotations.length === 0) {
    return ''
  }

  const firstAnnotation = annotations[0]
  const first = firstAnnotation.payload
  const lines: string[] = [
    `## Design Feedback: ${formatPageHeading(first)}`,
    '',
    `**URL:** ${first.page.sanitizedUrl}`,
    `**Browser tab id:** ${firstAnnotation.browserPageId}`,
    `**Viewport:** ${first.page.viewportWidth}x${first.page.viewportHeight}`,
    ''
  ]

  annotations.forEach((annotation, index) => {
    const { payload } = annotation
    const { target } = payload
    const rect = target.rectViewport
    const styleLines = formatStyles(target.computedStyles)

    lines.push(`### ${index + 1}. ${annotationElementLabel(payload)}`)
    lines.push(`**Intent:** ${annotation.intent}`)
    lines.push(`**Selector:** ${inlineCode(target.selector)}`)
    if (target.elementPath) {
      lines.push(`**Location:** ${inlineCode(target.elementPath)}`)
    }
    if (target.sourceFile) {
      lines.push(`**Source:** ${inlineText(target.sourceFile)}`)
    }
    if (target.reactComponents) {
      lines.push(`**React:** ${inlineText(target.reactComponents)}`)
    }
    lines.push(
      `**Bounds:** x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)}`
    )
    if (target.cssClasses) {
      lines.push(`**Classes:** ${inlineCode(target.cssClasses)}`)
    }
    if (target.selectedText) {
      lines.push(`**Selected text:** "${inlineText(target.selectedText)}"`)
    } else if (target.textSnippet) {
      lines.push(`**Text:** "${inlineText(target.textSnippet)}"`)
    }
    if (payload.nearbyText.length > 0) {
      lines.push('**Nearby text:**')
      for (const text of payload.nearbyText) {
        lines.push(`- ${inlineText(text)}`)
      }
    }
    if (target.nearbyElements?.length) {
      lines.push('**Nearby elements:**')
      for (const element of target.nearbyElements) {
        lines.push(`- ${inlineText(element)}`)
      }
    }
    if (styleLines.length > 0) {
      lines.push('**Computed styles:**')
      lines.push(...styleLines)
    }
    if (target.fullPath) {
      lines.push(`**Full DOM path:** ${inlineCode(target.fullPath)}`)
    }
    if (target.htmlSnippet) {
      lines.push('**HTML:**')
      lines.push(...fence('html', target.htmlSnippet))
    }
    lines.push(`**Feedback:** ${inlineText(annotation.comment)}`)
    lines.push('')
  })

  return lines.join('\n').trimEnd()
}
