const STARTUP_PROMPT_PREVIEW_CHARACTERS = 160
const STARTUP_PROMPT_PREVIEW_LINES = 4
const STARTUP_PROMPT_PREVIEW_URL_CHARACTERS = 64

function previewExcerpt(text: string, maxCharacters: number, maxLines: number): string {
  const lines = text.slice(0, (maxCharacters + 1) * 2).split(/\r\n?|\n/, maxLines + 1)
  const characters = Array.from(lines.slice(0, maxLines).join('\n'))
  return characters.length > maxCharacters || lines.length > maxLines
    ? `${characters
        .slice(0, maxCharacters - 1)
        .join('')
        .trimEnd()}…`
    : characters.join('')
}

export function startupPromptPreview(prompt: string): string {
  const text = prompt.trim()
  const preview = previewExcerpt(
    text,
    STARTUP_PROMPT_PREVIEW_CHARACTERS,
    STARTUP_PROMPT_PREVIEW_LINES
  )
  if (preview === text) {
    return preview
  }

  const tailStart = Math.max(0, text.length - STARTUP_PROMPT_PREVIEW_CHARACTERS * 2)
  const trailingUrl = /(?:^|\s)(https?:\/\/\S+)$/i.exec(text.slice(tailStart))
  const url = trailingUrl?.[1]
  if (!url) {
    return preview
  }

  const urlStart = text.length - url.length
  if (urlStart === tailStart && tailStart > 0 && !/\s/.test(text.charAt(tailStart - 1))) {
    return preview
  }

  const body = text.slice(0, urlStart).trimEnd()
  const footer = shortenPreviewUrl(url)
  if (!body) {
    return footer
  }
  const remaining = STARTUP_PROMPT_PREVIEW_CHARACTERS - Array.from(footer).length - 1
  return `${previewExcerpt(body, remaining, STARTUP_PROMPT_PREVIEW_LINES - 1)}\n${footer}`
}

function shortenPreviewUrl(url: string): string {
  const limit = STARTUP_PROMPT_PREVIEW_URL_CHARACTERS
  const start = Array.from(url.slice(0, limit * 2))
  if (url.length <= limit * 2 && start.length <= limit) {
    return start.join('')
  }
  const headLength = Math.floor(limit / 2)
  const tailLength = limit - headLength - 1
  const end = Array.from(url.slice(-tailLength * 2))
  return `${start.slice(0, headLength).join('')}…${end.slice(-tailLength).join('')}`
}
