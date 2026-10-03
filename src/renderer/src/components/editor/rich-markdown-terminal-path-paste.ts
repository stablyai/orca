import type { Editor } from '@tiptap/react'

type ClipboardAnchor = {
  href: string
}

const WINDOWS_ABSOLUTE_PATH_PREFIX =
  /(?:[A-Za-z]:[\\/](?:[^<>:"|?*\\/\r\n]+[\\/])*|\\\\[^\\/:*?"<>|\r\n]+\\(?:[^<>:"|?*\\/\r\n]+[\\/])*)/
    .source
const WINDOWS_PATH_TRAILING_BOUNDARY = /(?=$|[\s<>:"|?*\r\n])/.source

function readClipboardText(event: ClipboardEvent, type: string): string {
  return event.clipboardData?.getData(type) ?? ''
}

function extractClipboardAnchors(html: string): ClipboardAnchor[] {
  if (!html || typeof DOMParser === 'undefined') {
    return []
  }

  const document = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(document.querySelectorAll('a[href]'), (anchor) => ({
    href: anchor.getAttribute('href') ?? ''
  }))
}

function getHttpHostname(href: string): string | null {
  try {
    const url = new URL(href)
    return url.protocol.startsWith('http') ? url.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
}

function containsWindowsPathWithBasename(plainText: string, basename: string): boolean {
  if (!basename) {
    return false
  }

  const pattern = new RegExp(
    WINDOWS_ABSOLUTE_PATH_PREFIX + escapeRegExp(basename) + WINDOWS_PATH_TRAILING_BOUNDARY,
    'i'
  )
  return pattern.test(plainText)
}

export function shouldPasteTerminalWindowsPathAsPlainText({
  plainText,
  htmlText
}: {
  plainText: string
  htmlText: string
}): boolean {
  const anchors = extractClipboardAnchors(htmlText)
  if (anchors.length === 0) {
    return false
  }

  return anchors.some((anchor) => {
    const basename = getHttpHostname(anchor.href)
    return basename !== null && containsWindowsPathWithBasename(plainText, basename)
  })
}

export function handleRichMarkdownTerminalPathPaste(
  editor: Editor | null,
  event: ClipboardEvent
): boolean {
  if (event.defaultPrevented || !editor) {
    return false
  }

  const plainText = readClipboardText(event, 'text/plain')
  if (!plainText) {
    return false
  }

  if (
    !shouldPasteTerminalWindowsPathAsPlainText({
      plainText,
      htmlText: readClipboardText(event, 'text/html')
    })
  ) {
    return false
  }

  event.preventDefault()
  // Why: terminal link metadata can point at a synthetic basename URL; the
  // clipboard plain text is the only source that keeps the Windows path intact.
  editor.view.dispatch(editor.state.tr.insertText(plainText))
  return true
}
