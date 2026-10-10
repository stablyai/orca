import type { Editor } from '@tiptap/react'
import { escapeRegex } from '../../../../shared/string-utils'

type ClipboardAnchor = {
  href: string
  text: string
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
    href: anchor.getAttribute('href') ?? '',
    text: anchor.textContent?.trim() ?? ''
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

function getHttpHostnameFromLabel(label: string): string | null {
  if (!label) {
    return null
  }

  try {
    const url = new URL(`http://${label}`)
    if (
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.hostname.toLowerCase()
  } catch {
    return null
  }
}

function containsWindowsPathWithBasename(plainText: string, basename: string): boolean {
  if (!basename) {
    return false
  }

  const pattern = new RegExp(
    WINDOWS_ABSOLUTE_PATH_PREFIX +
      escapeRegex(basename) +
      String.raw`\.?` +
      WINDOWS_PATH_TRAILING_BOUNDARY,
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
    if (basename === null) {
      return false
    }

    if (containsWindowsPathWithBasename(plainText, basename)) {
      return true
    }

    const labelBasename = anchor.text
    return (
      getHttpHostnameFromLabel(labelBasename) === basename &&
      containsWindowsPathWithBasename(plainText, labelBasename)
    )
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
