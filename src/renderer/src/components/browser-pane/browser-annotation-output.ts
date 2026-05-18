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

function inlineText(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
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

function fence(language: string, content: string): string[] {
  const maxRun = Math.max(3, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length))
  const marker = '`'.repeat(maxRun + 1)
  return [`${marker}${language}`, content, marker]
}

function inlineCode(content: string): string {
  const maxRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length))
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
    `**Orca CLI:** Use ${inlineCode(`--page ${firstAnnotation.browserPageId}`)} to target this browser tab.`,
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
    lines.push(`**Priority:** ${annotation.priority}`)
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
