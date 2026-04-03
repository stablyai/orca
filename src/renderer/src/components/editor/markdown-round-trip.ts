import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'

// Why: extensions are lazily created on first use to avoid eager instantiation
// at import time. A single shared instance is safe here because only one
// round-trip Editor is alive at a time (created and destroyed synchronously).
let roundTripExtensions: ReturnType<typeof createRichMarkdownExtensions> | null = null
const roundTripCache = new Map<string, string | null>()
const MAX_CACHE_ENTRIES = 20

export function canRoundTripRichMarkdown(content: string): boolean {
  const output = getRichMarkdownRoundTripOutput(content)
  return output !== null && normalizeMarkdown(content) === normalizeMarkdown(output)
}

export function getRichMarkdownRoundTripOutput(content: string): string | null {
  const cached = roundTripCache.get(content)
  if (cached !== undefined) {
    return cached
  }

  let output: string | null = null

  try {
    if (!roundTripExtensions) {
      roundTripExtensions = createRichMarkdownExtensions()
    }
    const editor = new Editor({
      element: null,
      extensions: roundTripExtensions,
      content: encodeRawMarkdownHtmlForRichEditor(content),
      contentType: 'markdown'
    })
    try {
      output = editor.getMarkdown()
    } finally {
      editor.destroy()
    }
  } catch {
    output = null
  }

  roundTripCache.set(content, output)
  if (roundTripCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = roundTripCache.keys().next().value
    if (oldestKey) {
      roundTripCache.delete(oldestKey)
    }
  }

  return output
}

function normalizeMarkdown(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd()
}
