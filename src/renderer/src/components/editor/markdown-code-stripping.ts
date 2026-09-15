export function stripMarkdownCode(content: string): string {
  let sanitized = ''
  let activeFence: '`' | '~' | null = null
  let lineStart = 0

  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const index = newlineIndex === -1 ? content.length : newlineIndex
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    const line = content.slice(lineStart, lineEnd)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1][0] === '`' ? '`' : '~'
      activeFence = activeFence === fenceMarker ? null : fenceMarker
    } else if (!activeFence) {
      sanitized += line.replace(/`+[^`\n]*`+/g, '')
    }

    if (index < content.length) {
      sanitized += '\n'
    }
    lineStart = index + 1
  }

  return sanitized
}
