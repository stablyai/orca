import type { Editor } from '@tiptap/react'

type ClipboardAnchor = {
  href: string
}

const WINDOWS_ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s<>"|?*\r\n]+|\\\\[^\s\\/:*?"<>|\r\n]+\\[^\s\\/:*?"<>|\r\n]+(?:\\[^\s<>"|?*\r\n]+)*)/g

function readClipboardText(event: ClipboardEvent, type: string): string {
  return event.clipboardData?.getData(type) ?? ''
}

function getWindowsPathBasename(filePath: string): string {
  const normalized = filePath.replaceAll('/', '\\')
  const separatorIndex = normalized.lastIndexOf('\\')
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized
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

function hrefPointsAtPathBasename(href: string, basename: string): boolean {
  if (!href || !basename) {
    return false
  }

  try {
    const url = new URL(href)
    return url.protocol.startsWith('http') && url.hostname.toLowerCase() === basename.toLowerCase()
  } catch {
    return false
  }
}

export function shouldPasteTerminalWindowsPathAsPlainText({
  plainText,
  htmlText
}: {
  plainText: string
  htmlText: string
}): boolean {
  const paths = Array.from(plainText.matchAll(WINDOWS_ABSOLUTE_PATH_PATTERN), (match) => match[0])
  if (paths.length === 0) {
    return false
  }

  const anchors = extractClipboardAnchors(htmlText)
  if (anchors.length === 0) {
    return false
  }

  return paths.some((filePath) => {
    const basename = getWindowsPathBasename(filePath)
    return anchors.some((anchor) => hrefPointsAtPathBasename(anchor.href, basename))
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
